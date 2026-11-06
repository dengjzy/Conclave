import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentCall, AgentProfile, Conversation, CORE_FEATURES, PROTOCOL_VERSION, Task, remoteOperationSchemas, rpcSchemas } from '@conclave/protocol'
import type { EnvironmentService } from './environment-check'
import type { RpcHandlers } from './rpc-server'
import { createRemoteActions } from './remote-actions'
import { Rejection } from './rejection'

function task(updatedAt = 1) {
  return Task.parse({ id: randomUUID(), title: 'Remote task', details: 'PRIVATE_DETAILS', status: 'pending', repos: [], dependsOn: [], agent: 'codex', createdAt: 1, updatedAt })
}

function conversation(updatedAt = 1) {
  return Conversation.parse({ id: randomUUID(), title: 'Remote chat', titleLocked: false, agent: 'codex', workspacePath: '/registered/project', projectPaths: ['/registered/project'], managedWorkspace: false, sessionId: null, createdAt: 1, updatedAt })
}

function setup(tasks = [task()], conversations = [conversation()]) {
  const result = tasks[0] ?? task()
  const page = rpcSchemas['conversations.watchChat'].result.parse({ items: [], before: null })
  const chat = conversations[0] ?? conversation()
  const handlers = {
    'system.hello': vi.fn<RpcHandlers['system.hello']>(() => ({ protocolVersion: PROTOCOL_VERSION, serverVersion: 'test', features: [...CORE_FEATURES] })),
    'conversations.list': vi.fn<RpcHandlers['conversations.list']>(() => conversations),
    'conversations.create': vi.fn<RpcHandlers['conversations.create']>(() => chat),
    'conversations.continue': vi.fn<RpcHandlers['conversations.continue']>(() => chat),
    'conversations.configuration': vi.fn<RpcHandlers['conversations.configuration']>(() => ({ agent: 'codex', projectPaths: [], model: null, effort: null, permissionMode: 'ask' })),
    'conversations.chatCatalog': vi.fn<RpcHandlers['conversations.chatCatalog']>(() => null),
    'conversations.setOption': vi.fn<RpcHandlers['conversations.setOption']>(() => ({ ok: true })),
    'conversations.stages': vi.fn<RpcHandlers['conversations.stages']>(() => []),
    'conversations.handoff': vi.fn<RpcHandlers['conversations.handoff']>(() => chat),
    'tasks.handoff': vi.fn<RpcHandlers['tasks.handoff']>(() => result),
    'agentProfiles.list': vi.fn<RpcHandlers['agentProfiles.list']>(() => []),
    'agentProfiles.available': vi.fn<RpcHandlers['agentProfiles.available']>(() => []),
    'agentCalls.list': vi.fn<RpcHandlers['agentCalls.list']>(() => []),
    'agentCalls.dispatch': vi.fn<RpcHandlers['agentCalls.dispatch']>(() => { throw new Error('unused') }),
    'agentCalls.cancel': vi.fn<RpcHandlers['agentCalls.cancel']>(() => { throw new Error('unused') }),
    'projects.recent': vi.fn<RpcHandlers['projects.recent']>(() => ['/registered/project']),
    'tasks.get': vi.fn<RpcHandlers['tasks.get']>(() => result),
    'tasks.create': vi.fn<RpcHandlers['tasks.create']>(() => result),
    'tasks.start': vi.fn<RpcHandlers['tasks.start']>(() => result),
    'tasks.resumeChat': vi.fn<RpcHandlers['tasks.resumeChat']>(() => result),
    'conversations.get': vi.fn<RpcHandlers['conversations.get']>(() => { throw new Error('unused') }),
    'conversations.watchChat': vi.fn<RpcHandlers['conversations.watchChat']>(() => page),
    'conversations.chatItems': vi.fn<RpcHandlers['conversations.chatItems']>(() => page),
    'conversations.send': vi.fn<RpcHandlers['conversations.send']>(() => ({ ok: true })),
    'conversations.interrupt': vi.fn<RpcHandlers['conversations.interrupt']>(() => ({ ok: true })),
    'conversations.respond': vi.fn<RpcHandlers['conversations.respond']>(() => ({ ok: true }))
  }
  const check = vi.fn<EnvironmentService['check']>(async () => ({ checks: [], searchPath: [], checkedAt: 0 }))
  const list = vi.fn(() => tasks)
  const actions = createRemoteActions({ tasks: { list }, environment: { check }, handlers: () => handlers })
  const signal = new AbortController().signal
  return { actions, handlers, list, check, signal }
}

it('rejects non-allowlisted methods and privilege fields before invoking any handler', async () => {
  const { actions, handlers, signal } = setup()
  const id = randomUUID()
  const cases = [
    ['remote.createInvitation', {}],
    ['tasks.delete', { id }],
    ['tasks.start', { id, allowBypass: true }],
    ['tasks.start', { id, permissionMode: 'bypass' }],
    ['tasks.resumeChat', { id, allowBypass: true }],
    ['conversations.create', { agent: 'codex', projectPaths: [], permissionMode: 'auto' }],
    ['conversations.create', { agent: 'codex', projectPaths: [], allowBypass: true }],
    ['conversations.create', { agent: 'codex', projectPaths: [], worktree: true }],
    ['conversations.create', { agent: 'codex', projectPaths: [], helperOf: id }],
    ['conversations.setOption', { id, option: 'permissionMode', value: 'bypass' }],
    ['conversations.setOption', { id, option: 'permissionMode', value: 'acceptEdits' }],
    ['tasks.handoff', { id, agent: 'claude', note: '', allowBypass: true }],
    ['conversations.handoff', { id, agent: 'claude', note: '', stopRunning: true, references: [] }],
    ['agentCalls.dispatch', { id, profileId: randomUUID(), target: { agent: 'codex' }, instruction: 'work', ref: randomUUID() }],
    ['agentCalls.dispatch', { id, instruction: 'work', ref: randomUUID() }],
    ['agentCalls.dispatch', { id, target: { agent: 'codex', allowBypass: true }, instruction: 'work', ref: randomUUID() }],
    ['tasks.create', { title: 'task', repos: ['/registered/project'], agent: 'codex', images: [] }],
    ['conversations.send', { id, text: 'hello', ref: randomUUID(), queue: false }],
    ['conversations.respond', { id, requestId: 'approval-1', decision: 'allow', mode: 'bypass' }]
  ] as const
  for (const [method, params] of cases) await expect(actions(method, params, signal)).rejects.toMatchObject({ reason: 'remote-operation-not-allowed' })
  for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()
})

it('returns bounded sorted task summaries without details and reports pagination', async () => {
  const items = [task(1), task(30), task(20), task(10)]
  const { actions, signal } = setup(items)
  const page = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { offset: 1, limit: 2 }, signal))
  expect(page.items.map((entry) => entry.updatedAt)).toEqual([20, 10])
  expect(page).toMatchObject({ total: 4, nextOffset: 3 })
  expect(JSON.stringify(page)).not.toContain('PRIVATE_DETAILS')
  expect(page.items[0]).not.toHaveProperty('details')
  expect(page.items[0]).not.toHaveProperty('repos')
  await expect(actions('tasks.page', { limit: 21 }, signal)).rejects.toMatchObject({ reason: 'remote-operation-not-allowed' })
  const final = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { offset: 3, limit: 2 }, signal))
  expect(final.items).toHaveLength(1)
  expect(final.nextOffset).toBeNull()
})

it('keeps old task-page calls compatible and validates optional filters and search', async () => {
  expect(remoteOperationSchemas['tasks.page'].params.parse({})).toEqual({ offset: 0, limit: 20, filter: 'all', query: '' })
  expect(remoteOperationSchemas['tasks.page'].params.parse({ query: '  Mobile  ' })).toMatchObject({ query: 'Mobile' })
  const { actions, signal } = setup()
  for (const params of [{ filter: 'done' }, { query: 'a'.repeat(201) }]) {
    await expect(actions('tasks.page', params, signal)).rejects.toMatchObject({ reason: 'remote-operation-not-allowed' })
  }
  const page = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', {}, signal))
  expect(page).toMatchObject({ total: 1, nextOffset: null })
})

it('filters attention before pagination across raw pages without inferring it from task status', async () => {
  const items = Array.from({ length: 50 }, (_, index) => Task.parse({
    ...task(index), id: String(index), awaitingInput: [1, 12, 23, 41].includes(index),
    status: index === 41 ? 'done' : index === 23 ? 'pending' : index === 12 ? 'review' : 'running'
  }))
  const { actions, signal } = setup(items)
  const first = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { filter: 'attention', limit: 2 }, signal))
  expect(first.items.map((entry) => entry.id)).toEqual(['41', '23'])
  expect(first).toMatchObject({ total: 4, nextOffset: 2 })
  const second = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { filter: 'attention', offset: 2, limit: 2 }, signal))
  expect(second.items.map((entry) => entry.id)).toEqual(['12', '1'])
  expect(second).toMatchObject({ total: 4, nextOffset: null })
})

it('combines running and case-insensitive trimmed title search before pagination', async () => {
  const items = Array.from({ length: 50 }, (_, index) => Task.parse({
    ...task(index), id: String(index), title: [1, 12, 23, 41, 49].includes(index) ? `Build MoBiLe ${index}` : `Other ${index}`,
    details: 'mobile appears here but must not match', status: index === 49 ? 'review' : 'running',
    awaitingInput: index === 41
  }))
  const { actions, signal } = setup(items)
  const first = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { filter: 'running', query: '  mOBILE  ', limit: 2 }, signal))
  expect(first.items.map((entry) => entry.id)).toEqual(['41', '23'])
  expect(first).toMatchObject({ total: 4, nextOffset: 2 })
  const second = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { filter: 'running', query: 'mobile', offset: 2, limit: 2 }, signal))
  expect(second.items.map((entry) => entry.id)).toEqual(['12', '1'])
  expect(second).toMatchObject({ total: 4, nextOffset: null })
  const all = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { query: 'mobile' }, signal))
  expect(all.items.map((entry) => entry.id)).toEqual(['49', '41', '23', '12', '1'])
  expect(all.total).toBe(5)
  const missing = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { filter: 'running', query: 'missing' }, signal))
  expect(missing).toEqual({ items: [], total: 0, nextOffset: null })
})

it('creates tasks only in registered projects and rechecks cancellation after lookup', async () => {
  const { actions, handlers, signal } = setup()
  const fields = { title: 'Create from phone', details: 'details', agent: 'codex', repos: ['/registered/project'] }
  await expect(actions('tasks.create', { ...fields, repos: ['/unregistered/project'] }, signal)).rejects.toMatchObject({ reason: 'remote-project-not-registered' })
  expect(handlers['tasks.create']).not.toHaveBeenCalled()
  await actions('tasks.create', fields, signal)
  expect(handlers['tasks.create']).toHaveBeenCalledWith(fields, expect.any(Object))

  let resolveProjects: (projects: string[]) => void = () => {}
  handlers['projects.recent'].mockImplementationOnce(() => new Promise((resolve) => { resolveProjects = resolve }))
  const controller = new AbortController()
  const pending = actions('tasks.create', fields, controller.signal)
  controller.abort(new Error('device revoked'))
  resolveProjects(['/registered/project'])
  await expect(pending).rejects.toThrow('device revoked')
  expect(handlers['tasks.create']).toHaveBeenCalledOnce()
})

it('forces approval mode for task start and preserves the existing start and resume guards', async () => {
  const { actions, handlers, signal } = setup()
  const id = randomUUID()
  await actions('tasks.start', { id }, signal)
  expect(handlers['tasks.start']).toHaveBeenCalledWith({ id, permissionMode: 'ask', allowBypass: false }, expect.any(Object))
  await actions('tasks.resumeChat', { id }, signal)
  expect(handlers['tasks.resumeChat']).toHaveBeenCalledWith({ id, allowBypass: false }, expect.any(Object))
  const refusal = new Rejection('dependencies-unfinished')
  handlers['tasks.start'].mockRejectedValueOnce(refusal)
  await expect(actions('tasks.start', { id }, signal)).rejects.toBe(refusal)
})

it('preserves send references, queues messages, and propagates handler ownership guards', async () => {
  const { actions, handlers, signal } = setup()
  const params = { id: randomUUID(), text: 'hello from mobile', ref: randomUUID() }
  await actions('conversations.send', params, signal)
  expect(handlers['conversations.send']).toHaveBeenCalledWith({ ...params, queue: true }, expect.any(Object))
  const refusal = new Rejection('squad-managed')
  handlers['conversations.send'].mockRejectedValueOnce(refusal)
  await expect(actions('conversations.send', params, signal)).rejects.toBe(refusal)
  const interrupted = new Rejection('agent-call-managed')
  handlers['conversations.interrupt'].mockRejectedValueOnce(interrupted)
  await expect(actions('conversations.interrupt', { id: params.id }, signal)).rejects.toBe(interrupted)
})

it('does not invoke handlers after revocation and bounds the project and agent catalog', async () => {
  const { actions, handlers, check, signal } = setup()
  const controller = new AbortController()
  controller.abort(new Error('revoked'))
  await expect(actions('conversations.send', { id: randomUUID(), text: 'late', ref: randomUUID() }, controller.signal)).rejects.toThrow('revoked')
  expect(handlers['conversations.send']).not.toHaveBeenCalled()
  handlers['projects.recent'].mockReturnValue(Array.from({ length: 150 }, (_, i) => `/project/${i}`))
  check.mockResolvedValueOnce({
    checks: [
      { tool: 'git', status: 'ok', version: null, path: '/bin/git', signedIn: null },
      { tool: 'codex', status: 'ok', version: null, path: '/bin/codex', signedIn: true },
      { tool: 'claude', status: 'missing', version: null, path: null, signedIn: null }
    ], searchPath: [], checkedAt: 1
  })
  const catalog = remoteOperationSchemas.catalog.result.parse(await actions('catalog', {}, signal))
  expect(catalog.projects).toHaveLength(100)
  expect(catalog.agents.map((agent) => agent.id)).toEqual(['codex'])
  expect(check).toHaveBeenCalledWith(false)
})

it('polls chat pages through existing handlers without registering a real RPC connection', async () => {
  const { actions, handlers, signal } = setup()
  const id = randomUUID()
  const before = randomUUID()
  await actions('chat.page', { id }, signal)
  await actions('chat.page', { id, before }, signal)
  expect(handlers['conversations.watchChat']).toHaveBeenCalledWith({ id }, expect.objectContaining({ watching: new Set() }))
  expect(handlers['conversations.chatItems']).toHaveBeenCalledWith({ id, before }, expect.any(Object))
})

it('creates deferred standalone chats without a project and only in registered projects', async () => {
  const { actions, handlers, signal } = setup()
  await actions('conversations.create', { agent: 'codex', projectPaths: [] }, signal)
  expect(handlers['conversations.create']).toHaveBeenCalledWith({ agent: 'codex', projectPaths: [], deferStart: true, allowBypass: false, permissionMode: 'ask' }, expect.any(Object))
  expect(handlers['conversations.continue']).not.toHaveBeenCalled()
  expect(handlers['conversations.send']).not.toHaveBeenCalled()
  await expect(actions('conversations.create', { agent: 'codex', projectPaths: ['/unregistered'] }, signal)).rejects.toMatchObject({ reason: 'remote-project-not-registered' })
  expect(handlers['conversations.create']).toHaveBeenCalledOnce()
  await expect(actions('conversations.create', { agent: 'codex', projectPaths: [], agentPreset: 'invented' }, signal)).rejects.toMatchObject({ reason: 'invalid-agent-preset' })
  const id = randomUUID()
  await actions('conversations.continue', { id }, signal)
  expect(handlers['conversations.continue']).toHaveBeenCalledWith({ id, allowBypass: false }, expect.any(Object))
  const refusal = new Rejection('task-conversation')
  handlers['conversations.continue'].mockRejectedValueOnce(refusal)
  await expect(actions('conversations.continue', { id }, signal)).rejects.toBe(refusal)
})

it('validates operational presets against the agent descriptor without bypassing permission mode', async () => {
  const { actions, handlers, signal } = setup()
  await actions('conversations.create', { agent: 'dsh', projectPaths: [], agentPreset: 'standard', permissionMode: 'plan' }, signal)
  expect(handlers['conversations.create']).toHaveBeenCalledWith(expect.objectContaining({ agent: 'dsh', agentPreset: 'standard', permissionMode: 'plan', allowBypass: false }), expect.any(Object))
  await expect(actions('conversations.create', { agent: 'dsh', projectPaths: [], agentPreset: 'invented' }, signal)).rejects.toMatchObject({ reason: 'invalid-agent-preset' })
  const id = randomUUID()
  await actions('conversations.setOption', { id, option: 'agentPreset', value: 'ptc' }, signal)
  expect(handlers['conversations.setOption']).toHaveBeenCalledWith({ id, option: 'agentPreset', value: 'ptc' }, expect.any(Object))
  const refusal = new Rejection('profile-managed')
  handlers['conversations.setOption'].mockRejectedValueOnce(refusal)
  await expect(actions('conversations.setOption', { id, option: 'model', value: 'model' }, signal)).rejects.toBe(refusal)
})

it('separates standalone chats from owned conversations and filters project and attention before paging', async () => {
  const first = { ...conversation(10), title: 'A mobile chat', chat: { turn: 'awaiting' as const, request: { requestId: 'r', kind: 'approval' as const, tool: 'shell', title: 'approve', decisions: ['allow' as const], open: 1 } } }
  const second = { ...first, id: randomUUID(), updatedAt: 20 }
  const items = [first, second, conversation(30), { ...conversation(40), taskId: randomUUID() }, { ...conversation(50), routineId: randomUUID() }, { ...conversation(60), parentConversationId: randomUUID() }, { ...conversation(70), squadRunId: randomUUID() }, { ...conversation(80), helperOf: randomUUID() }, { ...conversation(90), archivedAt: 90 }, { ...first, id: randomUUID(), projectPaths: ['/other'], updatedAt: 100 }]
  const { actions, signal } = setup([], items)
  const page = remoteOperationSchemas['conversations.page'].result.parse(await actions('conversations.page', { filter: 'attention', query: '  MOBILE  ', project: '/registered/project', limit: 1 }, signal))
  expect(page.items.map((item) => item.id)).toEqual([second.id])
  expect(page).toMatchObject({ total: 2, nextOffset: 1 })
  const archived = remoteOperationSchemas['conversations.page'].result.parse(await actions('conversations.page', { archived: true }, signal))
  expect(archived.items).toHaveLength(1)
  expect(archived.items[0]?.archivedAt).toBe(90)
  await expect(actions('conversations.page', { project: '/unregistered' }, signal)).rejects.toMatchObject({ reason: 'remote-project-not-registered' })
})

it('counts registered projects and filters task repositories using their registered source paths', async () => {
  const items = [Task.parse({ ...task(), repos: [{ path: '/registered/project', worktreePath: '/worktrees/task', branch: 'work' }] }), task()]
  const { actions, signal } = setup(items, [conversation(), { ...conversation(), archivedAt: 10 }, { ...conversation(), taskId: items[0]?.id }])
  const projects = remoteOperationSchemas['projects.list'].result.parse(await actions('projects.list', {}, signal))
  expect(projects).toEqual([{ path: '/registered/project', name: 'project', taskCount: 1, conversationCount: 1 }])
  const page = remoteOperationSchemas['tasks.page'].result.parse(await actions('tasks.page', { project: '/registered/project' }, signal))
  expect(page.items.map((item) => item.id)).toEqual([items[0]?.id])
  await expect(actions('tasks.page', { project: '/worktrees/task' }, signal)).rejects.toMatchObject({ reason: 'remote-project-not-registered' })
})

it('routes task and standalone handoffs separately and preserves ownership and state rejections', async () => {
  const { actions, handlers, signal } = setup()
  const fields = { id: randomUUID(), agent: 'claude', note: 'continue from here', model: 'model', effort: 'high' }
  await actions('tasks.handoff', fields, signal)
  expect(handlers['tasks.handoff']).toHaveBeenCalledWith({ ...fields, allowBypass: false }, expect.any(Object))
  expect(handlers['conversations.handoff']).not.toHaveBeenCalled()
  const refusal = new Rejection('task-conversation')
  handlers['conversations.handoff'].mockRejectedValueOnce(refusal)
  await expect(actions('conversations.handoff', { ...fields, stopRunning: false }, signal)).rejects.toBe(refusal)
  expect(handlers['conversations.handoff']).toHaveBeenCalledWith({ ...fields, stopRunning: false, allowBypass: false }, expect.any(Object))
  const taskRefusal = new Rejection('dependencies-unfinished')
  handlers['tasks.handoff'].mockRejectedValueOnce(taskRefusal)
  await expect(actions('tasks.handoff', fields, signal)).rejects.toBe(taskRefusal)
})

it('advertises only available delegation capabilities and rejects forged unsupported calls', async () => {
  const { actions, handlers, signal } = setup()
  handlers['system.hello'].mockReturnValue({ protocolVersion: PROTOCOL_VERSION, serverVersion: 'test', features: [] })
  const catalog = remoteOperationSchemas.catalog.result.parse(await actions('catalog', {}, signal))
  expect(catalog.methods).toContain('conversations.create')
  expect(catalog.methods).not.toContain('agentCalls.dispatch')
  expect(catalog.capabilities).not.toContain('delegation')
  await expect(actions('agentCalls.dispatch', { id: randomUUID(), target: { agent: 'codex' }, instruction: 'check', ref: randomUUID() }, signal)).rejects.toMatchObject({ reason: 'remote-capability-unavailable' })
  expect(handlers['agentCalls.dispatch']).not.toHaveBeenCalled()
  await expect(actions('conversations.create', { agent: 'codex', projectPaths: [], profileId: randomUUID() }, signal)).rejects.toMatchObject({ reason: 'remote-capability-unavailable' })
  expect(handlers['conversations.create']).not.toHaveBeenCalled()
  handlers['system.hello'].mockReturnValue({ protocolVersion: PROTOCOL_VERSION, serverVersion: 'test', features: ['agent-profiles'] })
  await expect(actions('agentCalls.dispatch', { id: randomUUID(), target: { agent: 'codex' }, instruction: 'check', ref: randomUUID() }, signal)).rejects.toMatchObject({ reason: 'remote-capability-unavailable' })
  expect(handlers['agentCalls.dispatch']).not.toHaveBeenCalled()
})

it('retains role restrictions, direct-delegation read-only defaults, stable references and cancellation ownership', async () => {
  const { actions, handlers, signal } = setup()
  const fields = { id: randomUUID(), instruction: 'inspect this', ref: randomUUID() }
  const refusal = new Rejection('agent-call-managed')
  handlers['agentCalls.dispatch'].mockRejectedValue(refusal)
  await expect(actions('agentCalls.dispatch', { ...fields, target: { agent: 'claude' } }, signal)).rejects.toBe(refusal)
  expect(handlers['agentCalls.dispatch']).toHaveBeenCalledWith({ ...fields, target: { agent: 'claude', model: null, effort: null, modelProvider: null, capability: 'readOnly' } }, expect.any(Object))
  await expect(actions('agentCalls.dispatch', { ...fields, target: { agent: 'claude', capability: 'develop' } }, signal)).rejects.toBe(refusal)
  expect(handlers['agentCalls.dispatch']).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({ capability: 'develop' }) }), expect.any(Object))
  const profileId = randomUUID()
  await expect(actions('agentCalls.dispatch', { ...fields, profileId }, signal)).rejects.toBe(refusal)
  expect(handlers['agentCalls.dispatch']).toHaveBeenLastCalledWith({ ...fields, profileId }, expect.any(Object))
  const cancel = { id: fields.id, callId: randomUUID() }
  handlers['agentCalls.cancel'].mockRejectedValueOnce(new Rejection('agent-call-not-found'))
  await expect(actions('agentCalls.cancel', cancel, signal)).rejects.toMatchObject({ reason: 'agent-call-not-found' })
  expect(handlers['agentCalls.cancel']).toHaveBeenCalledWith(cancel, expect.any(Object))
})

it('excludes archived profiles and bounds roles while leaving per-parent eligibility to the host', async () => {
  const { actions, handlers, signal } = setup()
  const profile = AgentProfile.parse({ id: randomUUID(), name: 'Reader', agent: 'codex', createdAt: 1, updatedAt: 1, archivedAt: null })
  handlers['agentProfiles.list'].mockReturnValue([{ ...profile, archivedAt: 10 }, ...Array.from({ length: 110 }, () => ({ ...profile, id: randomUUID() }))])
  expect(await actions('agentProfiles.list', {}, signal)).toHaveLength(100)
  const id = randomUUID()
  handlers['agentProfiles.available'].mockReturnValue([profile])
  expect(await actions('agentProfiles.available', { id }, signal)).toEqual([profile])
  expect(handlers['agentProfiles.available']).toHaveBeenCalledWith({ id }, expect.any(Object))
})

it('keeps an old active delegated child visible beyond the completed-history limit', async () => {
  const { actions, handlers, signal } = setup()
  const id = randomUUID()
  const profile = AgentProfile.parse({ id: randomUUID(), name: 'Reader', agent: 'codex', createdAt: 1, updatedAt: 1, archivedAt: null })
  const old = AgentCall.parse({ id: randomUUID(), parentId: id, conversationId: randomUUID(), profile, instruction: 'work', permissionMode: 'readOnly', readOnly: true, state: 'awaiting', result: null, error: null, delivered: false, createdAt: 1, updatedAt: 1 })
  handlers['agentCalls.list'].mockReturnValue([old, ...Array.from({ length: 120 }, (_, index) => ({ ...old, id: randomUUID(), state: 'completed' as const, createdAt: index + 2 }))])
  const calls = remoteOperationSchemas['agentCalls.list'].result.parse(await actions('agentCalls.list', { id }, signal))
  expect(calls).toHaveLength(100)
  expect(calls[0]?.id).toBe(old.id)
  expect(calls.at(-1)?.createdAt).toBe(121)
})
