import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { AgentProfile, type AgentKind } from '@conclave/protocol'
import type { NativeSessions } from './native-session'
import { TaskStore } from './task-store'
import { ConversationStore } from './conversation-store'
import { ConversationService } from './conversation-service'
import { ProjectRegistry } from './project-registry'
import { AttachmentStore } from './attachment-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { claudeNativeSessions } from './agents/claude/claude-native-sessions'
import { codexNativeSessions } from './agents/codex/codex-native-sessions'
import { dshNativeSessions } from './agents/dsh/dsh-native-sessions'
import { ownedSessionLog } from './owned-native-sessions'

it('deletes real native files across handoffs, completed delegates and diagnostic sessions while preserving projects and independent forks', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'conclave-native-delete-integration-'))
  const database = path.join(root, 'conclave.db')
  const tasks = new TaskStore(database)
  const store = new ConversationStore(database)
  const projects = new ProjectRegistry(database)
  const sessions = path.join(root, 'conclave-sessions')
  const project = path.join(root, 'project')
  mkdirSync(project)
  writeFileSync(path.join(project, 'work.txt'), 'keep this work')
  const service = new ConversationService(store, fakeChatDaemon(), sessions, () => {}, projects, new AttachmentStore(path.join(root, 'attachments')))
  const claudeHome = path.join(root, 'claude')
  const codexHome = path.join(root, 'codex')
  const dshHome = path.join(root, 'dsh')
  const adapters = new Map<AgentKind, NativeSessions>([
    ['claude', claudeNativeSessions(() => claudeHome)], ['codex', codexNativeSessions(() => codexHome)], ['dsh', dshNativeSessions(() => dshHome)]
  ])
  const unexpectedProcess = async (): Promise<never> => { throw new Error('This integration test must not start an agent') }
  service.setNativeDeletion({ adapter: (agent) => adapters.get(agent),
    executor: { command: unexpectedProcess, acp: unexpectedProcess }, home: () => undefined }, async () => {})
  const write = (file: string, data: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(data)}\n`)
    return file
  }
  try {
    const parent = store.create('claude', project, [project])
    const child = store.create('dsh', project, [project])
    store.setProfile(child.id, AgentProfile.parse({ id: randomUUID(), name: 'Delegate', agent: 'dsh', archivedAt: null, createdAt: 0, updatedAt: 0 }), parent.id, null)
    const claudeId = randomUUID(), codexId = randomUUID(), dshId = randomUUID()
    const nativeChildId = randomUUID(), diagnosticId = randomUUID(), forkId = randomUUID()
    const claudeFile = write(path.join(claudeHome, 'projects', 'project', `${claudeId}.jsonl`), { type: 'user', sessionId: claudeId, cwd: project })
    const subagentFile = write(path.join(claudeHome, 'projects', 'project', claudeId, 'subagents', 'agent-test.jsonl'), { type: 'assistant' })
    const codexFile = write(path.join(codexHome, 'sessions', '2026', '11', '06', `rollout-test-${codexId}.jsonl`), { type: 'session_meta', payload: { id: codexId, cwd: project } })
    const dshFile = (id: string, extra: Record<string, unknown> = {}) => write(path.join(dshHome, 'sessions', 'project', id, 'session.v4.jsonl'), { type: 'session', id, cwd: project, ...extra })
    const dshParent = dshFile(dshId)
    const dshChild = dshFile(nativeChildId, { origin: 'subagent', parentSession: dshId })
    const diagnostic = dshFile(diagnosticId)
    const independent = dshFile(forkId, { parentSession: dshId })
    const cache = write(path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${dshId}.json`), { title: null })
    store.startStage(parent.id, 'claude', claudeId, 0)
    store.startStage(parent.id, 'codex', codexId, 0)
    store.startStage(child.id, 'dsh', dshId, 0)
    write(ownedSessionLog(sessions, parent.id), { agent: 'dsh', providerSessionId: diagnosticId, cwd: project, home: dshHome })
    await service.delete(parent.id)
    for (const file of [claudeFile, subagentFile, codexFile, dshParent, dshChild, diagnostic, cache]) expect(existsSync(file), file).toBe(false)
    expect(existsSync(independent)).toBe(true)
    expect(readFileSync(path.join(project, 'work.txt'), 'utf8')).toBe('keep this work')
    expect(store.get(parent.id)).toBeNull()
    expect(store.get(child.id)).toBeNull()
    expect(store.deletions()).toEqual([])
  } finally {
    projects.close(); store.close(); tasks.close()
    rmSync(root, { recursive: true, force: true })
  }
})
