import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { CORE_FEATURES, PROTOCOL_VERSION, REMOTE_DESKTOP_FEATURES, REMOTE_DESKTOP_METHODS, REMOTE_DESKTOP_WRITE_METHODS, REMOTE_WRITE_METHODS, RPC_ERROR, rpcSchemas, type RpcFrame, type RpcMethod, type RpcRequest } from '@conclave/protocol'
import type { Connection } from './rpc-server'
import { openRemoteRpcSession } from './remote-rpc'

function setup() {
  const connections = new Set<Connection>()
  const send = vi.fn<(frame: RpcFrame) => void>()
  const dispatch = vi.fn<(method: RpcMethod, params: unknown, connection: Connection) => unknown>((method) => {
    if (method === 'system.hello') return { protocolVersion: PROTOCOL_VERSION, serverVersion: 'test', features: [...CORE_FEATURES, 'future-host-admin'] }
    return []
  })
  const call = vi.fn(async (_method: string, _params: unknown, _signal: AbortSignal) => ({ ok: true }))
  const closed = vi.fn()
  const session = openRemoteRpcSession({ dispatch, call, connections, send, closed })
  let sequence = 0
  const request = (method: string, params: unknown = {}, requestId = randomUUID()) => session.request({ jsonrpc: '2.0', id: ++sequence, method, params }, new AbortController().signal, requestId)
  return { session, request, dispatch, call, connections, send, closed }
}

it('limits advertised desktop writes to the previously supported mobile control surface', () => {
  expect([...REMOTE_DESKTOP_WRITE_METHODS].sort()).toEqual([...REMOTE_WRITE_METHODS].sort())
  for (const method of ['remote.createInvitation', 'remote.revokeDevice', 'system.upgradeAgentCli', 'modelProviders.save', 'accounts.add', 'files.read', 'files.write', 'git.diff', 'git.execute', 'terminals.open', 'sessions.write', 'sessions.attach', 'attachments.read']) {
    expect(REMOTE_DESKTOP_METHODS.some((allowed) => allowed === method)).toBe(false)
  }
  for (const method of ['tasks.list', 'conversations.list', 'sources.list', 'sources.inbox', 'conversations.watchChat', 'todos.open']) {
    expect(REMOTE_DESKTOP_METHODS.some((allowed) => allowed === method)).toBe(true)
  }
})

it('registers real watch state, filters host-only notifications and removes it on close', async () => {
  const { session, connections, send, closed, dispatch, request } = setup()
  const connection = [...connections][0]
  if (!connection) throw new Error('missing connection')
  const cleanup = vi.fn()
  dispatch.mockImplementation((_method, params, attached) => {
    attached.watching.add('chat')
    attached.onClose(cleanup)
    return { items: [], before: null, params }
  })
  await request('conversations.watchChat', { id: randomUUID() })
  expect(connection.watching.has('chat')).toBe(true)
  connection.notify('conversations.chatDelta', { conversationId: 'chat', itemId: 'item', append: 'hello' })
  connection.notify('remote.changed', { status: { supported: true, state: 'ready', clientUrl: null, problem: null, access: 'control', devices: [] } })
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith({ jsonrpc: '2.0', method: 'conversations.chatDelta', params: { conversationId: 'chat', itemId: 'item', append: 'hello' } })
  session.close()
  session.close()
  expect(connections.size).toBe(0)
  expect(connection.watching.size).toBe(0)
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(closed).toHaveBeenCalledTimes(1)
  const late = vi.fn()
  connection.onClose(late)
  expect(late).toHaveBeenCalledOnce()
  connection.notify('git.changed', {})
  expect(send).toHaveBeenCalledTimes(1)
  expect(await request('tasks.list')).toMatchObject({ error: { data: { reason: 'remote-session-closed' } } })
})

it('validates canonical read parameters and advertises only usable features', async () => {
  const { request, dispatch } = setup()
  expect(await request('tasks.list', { status: 'unknown' })).toMatchObject({ error: { code: RPC_ERROR.invalidParams } })
  expect(dispatch).not.toHaveBeenCalled()
  const result = await request('system.hello', { protocolVersion: PROTOCOL_VERSION })
  if (!('result' in result)) throw new Error('hello failed')
  expect(rpcSchemas['system.hello'].result.parse(result.result).features?.sort()).toEqual([...REMOTE_DESKTOP_FEATURES].sort())
  expect(rpcSchemas['system.hello'].result.parse(result.result).features).not.toContain('durable-initial-message')
  for (const method of ['system.shutdown', 'files.read', 'git.execute', 'remote.start', 'accounts.add', 'conversations.submit']) {
    expect(await request(method)).toMatchObject({ error: { data: { reason: 'remote-method-denied' } } })
  }
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('forwards default original-UI writes through the existing mobile actions and supplies message refs', async () => {
  const { request, call, dispatch } = setup()
  const id = randomUUID()
  const requestId = randomUUID()
  await request('conversations.create', { agent: 'codex', projectPaths: [], deferStart: true, allowBypass: false, permissionMode: 'ask' })
  expect(call).toHaveBeenLastCalledWith('conversations.create', { agent: 'codex', projectPaths: [], permissionMode: 'ask' }, expect.any(AbortSignal))
  await request('conversations.continue', { id, allowBypass: false })
  expect(call).toHaveBeenLastCalledWith('conversations.continue', { id }, expect.any(AbortSignal))
  await request('conversations.send', { id, text: 'hello', images: [], references: [], queue: true }, requestId)
  expect(call).toHaveBeenLastCalledWith('conversations.send', { id, text: 'hello', ref: requestId }, expect.any(AbortSignal))
  await request('tasks.create', { title: 'Task', repos: ['/registered'], agent: 'codex', dependsOn: [], images: [] })
  expect(call).toHaveBeenLastCalledWith('tasks.create', { title: 'Task', repos: ['/registered'], agent: 'codex' }, expect.any(AbortSignal))
  expect(dispatch).not.toHaveBeenCalled()
})

it('refuses stronger or unsupported original-UI write options instead of changing their meaning', async () => {
  const { request, call, dispatch } = setup()
  const id = randomUUID()
  const cases: Pick<RpcRequest, 'method' | 'params'>[] = [
    { method: 'tasks.start', params: { id, permissionMode: 'bypass' } },
    { method: 'tasks.start', params: { id, model: 'different' } },
    { method: 'tasks.create', params: { title: 'Task', repos: [], agent: 'codex' } },
    { method: 'tasks.create', params: { title: 'Task', repos: ['/registered'], agent: null } },
    { method: 'conversations.create', params: { agent: 'codex', projectPaths: [], deferStart: false } },
    { method: 'conversations.create', params: { agent: 'codex', projectPaths: [], deferStart: true, worktree: true } },
    { method: 'conversations.create', params: { agent: 'codex', projectPaths: [], deferStart: true, branch: 'main' } },
    { method: 'conversations.create', params: { agent: 'codex', projectPaths: [], deferStart: true, allowBypass: true } },
    { method: 'conversations.setOption', params: { id, option: 'permissionMode', value: 'acceptEdits' } },
    { method: 'conversations.send', params: { id, text: 'hello', queue: false } },
    { method: 'conversations.send', params: { id, text: 'hello', steer: true } },
    { method: 'conversations.send', params: { id, text: 'hello', images: ['image'] } },
    { method: 'conversations.send', params: { id, text: 'hello', references: [{ kind: 'file', path: '/project' }] } },
    { method: 'conversations.respond', params: { id, requestId: 'approval', decision: 'allow', mode: 'bypass' } }
  ]
  for (const { method, params } of cases) expect(await request(method, params)).toMatchObject({ error: { data: { reason: 'remote-parameter-denied' } } })
  expect(call).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
})


it('marks unexpected write failures as uncertain so clients do not replay them', async () => {
  const { request, call } = setup()
  call.mockRejectedValueOnce(new Error('backend failed after dispatch'))
  expect(await request('conversations.send', { id: randomUUID(), text: 'submitted once' })).toMatchObject({ error: { code: RPC_ERROR.internal, data: { reason: 'operation-failed' } } })
  expect(call).toHaveBeenCalledOnce()
})
