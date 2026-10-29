import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Transcript, TranscriptSummary } from './agent-transcripts'
import { AttachmentStore } from './attachment-store'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { ProjectRegistry } from './project-registry'
import { SessionImports } from './session-imports'
import { TaskStore } from './task-store'

const SESSION = '0b6c1f9e-6a7d-4d0e-9f43-2a51c3e1b001'

// A turn of the session as its transcript gives it: the prompt, the reply, the turn closing.
function turn(ref: string, at: number, prompt: string, reply: string): Transcript {
  return {
    entries: [
      { at, item: { id: `u:${ref}`, kind: 'user', text: prompt, images: [] } },
      { at: at + 1, item: { id: `c:${ref}:0`, kind: 'assistant', text: reply, streaming: false } },
      { at: at + 1, item: { id: `turn:${ref}`, kind: 'turn', state: 'completed', error: null, durationMs: 1, usage: null, providerRef: `${ref}-reply` } }
    ],
    messages: [{ at, role: 'user', text: prompt, ref }, { at: at + 1, role: 'assistant', text: reply, ref }]
  }
}
const joined = (...parts: Transcript[]): Transcript => ({ entries: parts.flatMap((part) => part.entries), messages: parts.flatMap((part) => part.messages) })

describe('SessionImports', () => {
  let root: string
  let project: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeChatDaemon>
  let service: ConversationService
  let summaries: TranscriptSummary[]
  let transcripts: Map<string, Transcript>
  let imports: SessionImports

  const summary = (sessionId: string, extra: Partial<TranscriptSummary> = {}): TranscriptSummary =>
    ({ sessionId, cwd: project, title: 'Fix the build', named: false, firstPrompt: 'Fix the build', startedAt: 1, modifiedAt: 1_000, file: sessionId, ...extra })

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-session-imports-'))
    project = path.join(root, 'app')
    mkdirSync(project)
    mkdirSync(path.join(root, 'attachments'))
    const database = path.join(root, 'conclave.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    daemon = fakeChatDaemon()
    service = new ConversationService(store, daemon, path.join(root, 'sessions'), () => {}, projects, new AttachmentStore(path.join(root, 'attachments')))
    daemon.deliver = (event) => {
      if (event.event === 'data') service.handleData(event)
      else if (event.event === 'exit') service.handleExit(event.sessionId, event.exitCode)
      else service.handleStderr(event.sessionId, event.data)
    }
    summaries = [summary(SESSION)]
    transcripts = new Map([[SESSION, turn('u1', 100, 'Fix the build', 'Fixed.')]])
    const origin = { agent: 'claude' as const, transcripts: { scan: async () => summaries, read: async (file: string) => transcripts.get(file)! } }
    imports = new SessionImports(store, service, path.join(root, 'home'), [origin], [])
  })

  afterEach(() => {
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('imports a session as a conversation that resumes it in its own folder', async () => {
    expect(await imports.list()).toEqual([expect.objectContaining({ agent: 'claude', sessionId: SESSION, status: 'new', conversationId: null, problem: null })])
    const [imported] = await imports.import([{ agent: 'claude', sessionId: SESSION }])
    expect(imported).toMatchObject({ agent: 'claude', title: 'Fix the build', titleLocked: false, workspacePath: realpathSync(project), sessionId: null })
    const [stage] = service.stages(imported!.id)
    expect(stage).toMatchObject({ providerSessionId: SESSION, endedAt: expect.any(Number) })
    expect(service.stageChatItems(imported!.id, stage!.id).filter((item) => item.kind !== 'state').map((item) => [item.kind, item.id])).toEqual([['user', 'u:u1'], ['assistant', 'c:u1:0'], ['turn', 'turn:u1']])
    expect(service.messages(imported!.id).map(({ role, text }) => [role, text])).toEqual([['user', 'Fix the build'], ['assistant', 'Fixed.']])
    expect(await imports.list()).toEqual([expect.objectContaining({ status: 'imported', conversationId: imported!.id })])

    await service.continue(imported!.id)
    expect(daemon.spawns.at(-1)).toMatchObject({ command: 'claude', cwd: realpathSync(project) })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume', SESSION]))
  })

  it('brings in what the terminal added since, not what ran here', async () => {
    const [imported] = await imports.import([{ agent: 'claude', sessionId: SESSION }])
    await service.continue(imported!.id)
    const ran = service.stages(imported!.id).at(-1)!
    await service.stop(imported!.id)
    const later = Date.now() + 60_000
    transcripts.set(SESSION, joined(turn('u1', 100, 'Fix the build', 'Fixed.'), turn('here', ran.startedAt, 'Asked in Conclave', 'Answered here'), turn('u2', later, 'Asked in the terminal', 'Answered there')))
    summaries = [summary(SESSION, { modifiedAt: later + 1 })]
    expect(await imports.list()).toEqual([expect.objectContaining({ status: 'updated', conversationId: imported!.id })])

    await imports.import([{ agent: 'claude', sessionId: SESSION }])
    const stages = service.stages(imported!.id)
    expect(stages).toHaveLength(3)
    expect(stages.at(-1)).toMatchObject({ providerSessionId: SESSION })
    expect(service.stageChatItems(imported!.id, stages.at(-1)!.id).flatMap((item) => (item.kind === 'user' ? [item.text] : []))).toEqual(['Asked in the terminal'])
    expect(await imports.list()).toEqual([expect.objectContaining({ status: 'imported' })])
    // Nothing new: importing again changes nothing.
    await imports.import([{ agent: 'claude', sessionId: SESSION }])
    expect(service.stages(imported!.id)).toHaveLength(3)
  })

  it("leaves out Conclave's own sessions and those in its folders", async () => {
    const own = await service.create('claude', [project])
    const ownSession = service.stages(own.id)[0]!.providerSessionId!
    const home = path.join(root, 'home', 'worktrees', 'x')
    mkdirSync(home, { recursive: true })
    summaries = [summary(SESSION), summary(ownSession), summary('1e0c0b45-2a0b-4c8e-8a39-6c2a0d4f9d10', { cwd: home })]
    expect((await imports.list()).map((session) => session.sessionId)).toEqual([SESSION])
  })

  it('refuses a session whose folder is gone, or one it does not list', async () => {
    summaries = [summary(SESSION, { cwd: path.join(root, 'gone') })]
    expect(await imports.list()).toEqual([expect.objectContaining({ problem: 'missing-cwd' })])
    await expect(imports.import([{ agent: 'claude', sessionId: SESSION }])).rejects.toMatchObject({ reason: 'invalid-workspace' })
    await expect(imports.import([{ agent: 'claude', sessionId: '../../etc/passwd' }])).rejects.toMatchObject({ reason: 'invalid-params' })
    await expect(imports.import([{ agent: 'codex', sessionId: SESSION }])).rejects.toMatchObject({ reason: 'session-not-found' })
  })
})
