import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { TaskStore } from './task-store'
import { ProjectRegistry } from './project-registry'
import { AttachmentStore } from './attachment-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { antigravity } from './agents/antigravity/antigravity-adapter'
import { AgentAccountStore } from './agent-accounts'
import { agentCliAccess } from './agent-cli-access'

let root: string
let tasks: TaskStore
let store: ConversationStore
let projects: ProjectRegistry
let service: ConversationService
let daemon: ReturnType<typeof fakeChatDaemon>
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'conclave-account-catalog-'))
  const database = path.join(root, 'conclave.db')
  tasks = new TaskStore(database); store = new ConversationStore(database); projects = new ProjectRegistry(database)
  daemon = fakeChatDaemon()
  service = new ConversationService(store, daemon, path.join(root, 'sessions'), () => {}, projects, new AttachmentStore(path.join(root, 'attachments')), null, path.join(root, 'worktrees'))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); projects.close(); store.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })

it('probes Antigravity models in the selected account and refreshes them after switching', async () => {
  const adapter = antigravity
  const executor = { command: async () => '', acp: async () => null }
  service.setNativeDeletion({ adapter: () => undefined, executor, home: () => undefined }, async () => {})
  let active = 'a'
  const catalog = vi.spyOn(adapter, 'catalog').mockImplementation(async (_cwd, _executor, env) => ({ models: [{ id: env?.GEMINI_HOME ?? 'default', label: active, description: null, efforts: [], isDefault: true }] }))
  service.setAccounts({ activeOf: () => active, launch: async () => ({ id: active, env: adapter.accounts!.env(path.join(root, active)) }) })
  expect((await service.chatCatalog(adapter.kind))?.models[0]?.id).toBe(path.join(root, 'a'))
  expect(catalog).toHaveBeenCalledWith(path.join(root, 'sessions'), executor, adapter.accounts!.env(path.join(root, 'a')))
  active = 'b'
  service.invalidateCli(adapter.kind)
  expect((await service.chatCatalog(adapter.kind))?.models[0]?.id).toBe(path.join(root, 'b'))
  expect(catalog).toHaveBeenCalledTimes(2)
})

it('does not spawn with an account removed after its home was selected but before skills finished', async () => {
  vi.stubEnv('GEMINI_HOME', path.join(root, 'own-antigravity'))
  vi.spyOn(antigravity.accounts!, 'loginCommand').mockResolvedValue({ command: 'test-login', args: [] })
  vi.spyOn(antigravity.launch!, 'prepare').mockResolvedValue({ command: 'test-antigravity' })
  const changed = vi.fn()
  const accounts = new AgentAccountStore(path.join(root, 'accounts.json'), path.join(root, 'accounts'), {
    signIn: async () => ({ id: 'login', sessionId: 'login-process', cwd: root, title: 'login', createdAt: 0 }),
    waitForExit: async () => 0,
    processes: async () => (await daemon.request('list', {})).sessions,
    accountChanged: changed,
    changed: () => {},
    newId: () => 'work'
  })
  await accounts.load()
  await accounts.add('antigravity', 'Work')
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('antigravity', 'work', false))
  await accounts.activate('antigravity', 'work')
  service.setAccounts(accounts)
  let finishSkills: (() => void) | undefined
  const skills = vi.fn(() => new Promise<null>((resolve) => { finishSkills = () => resolve(null) }))
  service.setSkillsProvider(skills)
  const conversation = await service.create('antigravity', [], false, { deferStart: true })
  const spawned = vi.fn()
  const request = daemon.request
  daemon.request = async (method, params) => {
    if (method === 'spawnPipe') { spawned(); throw new Error('unexpected spawnPipe') }
    return request(method, params)
  }
  const starting = service.continue(conversation.id)
  const rejected = expect(starting).rejects.toMatchObject({ reason: 'account-unknown' })
  await vi.waitFor(() => expect(skills).toHaveBeenCalledOnce())
  expect(store.latestStage(conversation.id, 'antigravity')?.account).toBe('work')
  await accounts.remove('antigravity', 'work')
  expect(agentCliAccess.blocked('antigravity')).toBe(false)
  finishSkills?.()
  await rejected
  expect(spawned).not.toHaveBeenCalled()
  expect(existsSync(path.join(root, 'accounts/antigravity/work'))).toBe(true)
  expect(service.stages(conversation.id)).toEqual([])
})
