import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRpcClient, RpcRequest, Task, type RpcConnection } from '@conclave/protocol'
import { perform, startCoreConnection, useCore } from './core-store'

const mocks = vi.hoisted(() => {
  const permissions: { methods: string[] | null } = { methods: null }
  return { endpoint: vi.fn(), permissions }
})
vi.mock('./core-endpoint', () => ({ resolveCoreEndpoint: mocks.endpoint }))
vi.mock('./remote/node-rpc', () => ({
  nodeRpcMethods: () => mocks.permissions.methods,
  nodeRpcSupports: (_rpc: unknown, method: string) => mocks.permissions.methods === null || mocks.permissions.methods.includes(method)
}))
const stopped: Array<() => void> = []
function fakeRpc() {
  let close: () => void = () => {}
  const closed = new Promise<void>((resolve) => { close = resolve })
  const sent: string[] = []
  const client = createRpcClient((text) => {
    const request = RpcRequest.parse(JSON.parse(text))
    sent.push(request.method)
    void Promise.resolve().then(() => client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [] })))
  })
  const rpc: RpcConnection = { ...client, features: [], closed, close: vi.fn(close) }
  return { rpc, sent }
}
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve() }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  mocks.permissions.methods = null
  useCore.setState(useCore.getInitialState(), true)
})
afterEach(() => { for (const stop of stopped.splice(0)) stop(); vi.clearAllTimers(); vi.useRealTimers() })

describe('injected desktop RPC lifetime', () => {
  it('never discovers local core while the remote connector waits or retries', async () => {
    const connect = vi.fn<() => Promise<RpcConnection | null>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null)
    const stop = startCoreConnection('requests', connect); stopped.push(stop)
    await settle(); await vi.advanceTimersByTimeAsync(1000)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(useCore.getState().connection).toBe('waiting-for-core')
    expect(mocks.endpoint).not.toHaveBeenCalled()
    stop(); await vi.advanceTimersByTimeAsync(2000)
    expect(connect).toHaveBeenCalledTimes(2)
  })
  it('closes a delayed connection after disposal without publishing or bootstrapping it', async () => {
    let finish: (rpc: RpcConnection) => void = () => {}
    const connect = () => new Promise<RpcConnection>((resolve) => { finish = resolve })
    const stop = startCoreConnection('requests', connect); stopped.push(stop)
    const { rpc, sent } = fakeRpc()
    stop(); finish(rpc); await settle()
    expect(rpc.close).toHaveBeenCalledOnce()
    expect(sent).toEqual([])
    expect(useCore.getState()).toMatchObject({ rpc: null, connection: 'waiting-for-core' })
  })
  it('stops notifications and reconnect attempts when the document session is disposed', async () => {
    const { rpc } = fakeRpc()
    const connect = vi.fn(async () => rpc)
    const stop = startCoreConnection('requests', connect); stopped.push(stop)
    await settle()
    expect(useCore.getState().connection).toBe('connected')
    const task = Task.parse({ id: 'task-one', title: '当前节点任务', details: '', status: 'pending', repos: [], dependsOn: [], agent: 'codex', createdAt: 0, updatedAt: 0 })
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', method: 'tasks.changed', params: { task } }))
    expect(useCore.getState().tasks[task.id]?.title).toBe('当前节点任务')
    stop()
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', method: 'tasks.changed', params: { task: { ...task, title: '过期通知' } } }))
    expect(useCore.getState().tasks[task.id]?.title).toBe('当前节点任务')
    await vi.advanceTimersByTimeAsync(2000)
    expect(connect).toHaveBeenCalledOnce()
  })
  it('rejects unsupported desktop actions before sending while retaining the connection', async () => {
    const { rpc, sent } = fakeRpc()
    mocks.permissions.methods = ['tasks.list']
    useCore.setState({ rpc, connection: 'connected' })
    expect(await perform((client) => client.call('terminals.open', { cwd: '/project' }))).toBeNull()
    expect(sent).toEqual([])
    expect(useCore.getState().error).toContain('节点电脑')
    expect(useCore.getState().rpc).toBe(rpc)
    expect(rpc.close).not.toHaveBeenCalled()
  })
})
