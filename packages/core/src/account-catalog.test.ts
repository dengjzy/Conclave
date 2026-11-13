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

it('ignores a retired Antigravity stage lacking plan mode and re-probes antigravity.catalog', async () => {
  vi.spyOn(antigravity.launch!, 'prepare').mockResolvedValue({ command: 'agy', args: ['acp', '--stdio'] })
  service.setNativeDeletion({ adapter: () => undefined, executor: { command: async () => '', acp: async () => null }, home: () => undefined }, async () => {})
  daemon.deliver = (event) => {
    if (event.event === 'data') service.handleData(event)
    else if (event.event === 'exit') service.handleExit(event.sessionId, event.exitCode)
    else service.handleStderr(event.sessionId, event.data)
  }
  daemon.answerInit = false
  const originalRequest = daemon.request
  let spawnedId = ''
  daemon.request = async (method, params) => {
    const result = await originalRequest(method, params)
    if (method === 'spawnPipe' && result && typeof result === 'object' && 'sessionId' in result && typeof result.sessionId === 'string') {
      spawnedId = result.sessionId
    }
    if (method === 'write' && params && typeof params === 'object' && 'sessionId' in params && 'data' in params && typeof params.sessionId === 'string' && typeof params.data === 'string') {
      const targetId = params.sessionId
      for (const line of params.data.split('\n').filter(Boolean)) {
        const req = JSON.parse(line)
        if (req && typeof req === 'object' && req.method === 'initialize') {
          queueMicrotask(() => daemon.emit(targetId, { id: req.id, result: { protocolVersion: 1, authMethods: [] } }))
        } else if (req && typeof req === 'object' && req.method === 'session/new') {
          queueMicrotask(() => daemon.emit(targetId, {
            id: req.id,
            result: {
              sessionId: 'legacy-session',
              modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
              models: { currentModelId: 'stale-legacy-model', availableModels: [{ modelId: 'stale-legacy-model', name: 'Stale Legacy' }] }
            }
          }))
        }
      }
    }
    return result
  }

  const conversation = await service.create('antigravity', [], false)
  await vi.waitFor(() => {
    const stage = service.stages(conversation.id).at(-1)
    const items = stage ? service.stageChatItems(conversation.id, stage.id) : []
    expect(items.some((item) => item.kind === 'state' && item.models.some((m) => m.id === 'stale-legacy-model'))).toBe(true)
  })
  daemon.exit(spawnedId, 0)
  await vi.waitFor(() => expect(service.stages(conversation.id).at(-1)?.endedAt).not.toBeNull())

  // Simulate restart without in-memory catalog cache.
  const reloaded = new ConversationService(store, daemon, path.join(root, 'sessions'), () => {}, projects, new AttachmentStore(path.join(root, 'attachments')), null, path.join(root, 'worktrees'))
  reloaded.setNativeDeletion({ adapter: () => undefined, executor: { command: async () => '', acp: async () => null }, home: () => undefined }, async () => {})
  const catalogSpy = vi.spyOn(antigravity, 'catalog').mockResolvedValue({
    models: [{ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', description: null, efforts: ['low', 'high'], isDefault: true }]
  })

  const fresh = await reloaded.chatCatalog('antigravity')
  expect(catalogSpy).toHaveBeenCalledOnce()
  expect(fresh?.models.map((m) => m.id)).toEqual(['gemini-3.1-pro'])
})
