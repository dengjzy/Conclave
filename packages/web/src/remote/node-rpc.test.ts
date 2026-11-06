import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, RemoteWireRequest, RpcError, type RpcFrame } from '@conclave/protocol'
import { NodeConnection } from './node-connection'
import type { NodePlatform } from './node-platform'
import { connectDesktopRpc, nodeRpcMethods, nodeRpcSupports } from './node-rpc'

const deviceId = '11111111-1111-4111-8111-111111111111'
const nodeId = '22222222-2222-4222-8222-222222222222'
const conversationId = '33333333-3333-4333-8333-333333333333'
const clients: NodeConnection[] = []

class Tunnel {
  frames: RemoteWireRequest[] = []
  methods = ['system.hello', 'tasks.list', 'conversations.interrupt']
  capabilities = ['desktop-workspace']
  protocolVersion = PROTOCOL_VERSION
  helloVersion = PROTOCOL_VERSION
  ignoreClose = false
  closed = false
  respond: (request: Extract<RemoteWireRequest, { kind: 'rpc' }>) => void = () => {}
  onWrite: ((frame: RemoteWireRequest) => void) | undefined
  private chunks: Array<Uint8Array | null> = []
  private reader: ((chunk: Uint8Array | null) => void) | null = null
  async read(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift()
    if (chunk !== undefined) return chunk
    if (this.closed && !this.ignoreClose) return null
    return new Promise((resolve) => { this.reader = resolve })
  }
  async write(bytes: Uint8Array): Promise<void> {
    const frame = RemoteWireRequest.parse(JSON.parse(new TextDecoder().decode(bytes)))
    this.frames.push(frame)
    this.onWrite?.(frame)
    if (frame.kind === 'resume') this.receive({ kind: 'resumed', id: frame.id, deviceId, nodeId })
    if (frame.kind === 'operation' && frame.operation.method === 'catalog') this.receive({ kind: 'operation', id: frame.id, result: { projects: [], agents: [], capabilities: this.capabilities } })
    if (frame.kind === 'desktop') this.receive({ kind: 'desktop', id: frame.id, protocolVersion: this.protocolVersion, methods: this.methods })
    if (frame.kind === 'ping') this.receive({ kind: 'pong', id: frame.id, now: Date.now() })
    if (frame.kind === 'rpc') {
      if (frame.request.method === 'system.hello') this.rpc({ jsonrpc: '2.0', id: frame.request.id, result: { protocolVersion: this.helloVersion, serverVersion: '0.0.1-test', features: ['chat-options', 'conversation-todos'] } })
      else this.respond(frame)
    }
  }
  receive(frame: object | null): void {
    const chunk = frame === null ? null : new TextEncoder().encode(JSON.stringify(frame) + '\n')
    if (this.reader) { const reader = this.reader; this.reader = null; reader(chunk) }
    else this.chunks.push(chunk)
  }
  rpc(frame: RpcFrame): void { this.receive({ kind: 'rpc', frame }) }
  close(): void { this.closed = true; if (!this.ignoreClose) this.receive(null) }
  get rpcFrames() { return this.frames.filter((frame) => frame.kind === 'rpc') }
}

async function connected(tunnel = new Tunnel()) {
  const dial = vi.fn().mockResolvedValue(tunnel)
  const stored = new Map<string, string>([['conclave-mobile-hosts-v3', JSON.stringify({ version: 3, hosts: [{
    id: deviceId, nodeId, address: 'test-node', port: 443, deviceId, deviceToken: 'B'.repeat(43), name: 'Test node', deviceName: 'Test browser', lastConnectedAt: null
  }] })]])
  const platform: NodePlatform = {
    credentials: { async read(key) { return stored.get(key) ?? null }, async write(key, value) { if (value === null) stored.delete(key); else stored.set(key, value); return true } },
    preferences: { read: () => null, write: () => true }, takeInvitation: () => null,
    prepareNetwork: async () => {}, dial, isActive: () => true, subscribeActivity: () => () => {}
  }
  const node = new NodeConnection(() => {}, platform)
  clients.push(node)
  await node.connect('Test browser')
  return { node, tunnel, dial }
}
async function desktop(node: NodeConnection) {
  const rpc = await connectDesktopRpc(node)
  await vi.advanceTimersByTimeAsync(50)
  return rpc
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  for (const node of clients.splice(0)) node.disconnect()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('desktop node RPC', () => {
  it('negotiates desktop access, validates RPC results and forwards live notifications', async () => {
    const { node, tunnel } = await connected()
    tunnel.respond = ({ request }) => tunnel.rpc({ jsonrpc: '2.0', id: request.id, result: [] })
    const rpc = await desktop(node)
    expect(rpc.features).toEqual(['chat-options', 'conversation-todos'])
    expect(tunnel.frames.map((frame) => frame.kind)).toEqual(['resume', 'operation', 'desktop', 'rpc'])
    await expect(rpc.call('tasks.list', {})).resolves.toEqual([])
    const deleted = vi.fn()
    const stop = rpc.on('tasks.deleted', deleted)
    tunnel.rpc({ jsonrpc: '2.0', method: 'tasks.deleted', params: { id: 'task-1' } })
    await flush()
    expect(deleted).toHaveBeenCalledWith({ id: 'task-1' })
    stop()
    tunnel.rpc({ jsonrpc: '2.0', method: 'tasks.deleted', params: { id: 'task-2' } })
    await flush()
    expect(deleted).toHaveBeenCalledTimes(1)
  })

  it('retains a legacy mobile connection when the node does not offer desktop access', async () => {
    const { node, tunnel } = await connected()
    tunnel.capabilities = ['conversations']
    await expect(connectDesktopRpc(node)).rejects.toMatchObject({ code: 'desktop-unavailable', outcomeUnknown: false })
    expect(node.connected).toBe(true)
    expect(tunnel.frames.some((frame) => frame.kind === 'desktop')).toBe(false)
  })

  it('rejects unannounced methods locally without dropping the session', async () => {
    const { node, tunnel } = await connected()
    const rpc = await desktop(node)
    const count = tunnel.frames.length
    await expect(rpc.call('system.pickFolder', {})).rejects.toMatchObject({ reason: 'remote-method-denied' })
    expect(tunnel.frames).toHaveLength(count)
    expect(nodeRpcSupports(rpc, 'system.pickFolder')).toBe(false)
    expect(nodeRpcSupports(rpc, 'tasks.list')).toBe(true)
    expect(nodeRpcMethods(rpc)).toEqual(tunnel.methods)
    expect(node.connected).toBe(true)
  })

  it.each(['protocolVersion', 'helloVersion'] as const)('rejects an incompatible %s and closes the connection', async (field) => {
    const { node, tunnel } = await connected()
    tunnel[field] = PROTOCOL_VERSION + 1
    await expect(connectDesktopRpc(node)).rejects.toMatchObject({ code: 'protocol-mismatch' })
    expect(node.connected).toBe(false)
    expect(tunnel.closed).toBe(true)
  })

  it('preserves a server rejection with its RPC reason', async () => {
    const { node, tunnel } = await connected()
    const rpc = await desktop(node)
    tunnel.respond = ({ request }) => tunnel.rpc({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'This action is unavailable', data: { reason: 'remote-method-denied' } } })
    const failure = await rpc.call('conversations.interrupt', { id: conversationId }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RpcError)
    expect(failure).toMatchObject({ reason: 'remote-method-denied' })
    expect(node.connected).toBe(true)
  })

  it('marks a lost write result as unknown, settles closed and never replays after reconnect', async () => {
    const { node, tunnel, dial } = await connected()
    const rpc = await desktop(node)
    const pending = rpc.call('conversations.interrupt', { id: conversationId }).catch((error: unknown) => error)
    await flush()
    expect(tunnel.rpcFrames.at(-1)?.requestId).toMatch(/^[0-9a-f-]{36}$/)
    tunnel.receive(null)
    await rpc.closed
    expect(await pending).toMatchObject({ outcomeUnknown: true, code: 'connection-closed' })
    const next = new Tunnel()
    dial.mockResolvedValueOnce(next)
    await node.connect('Test browser')
    await connectDesktopRpc(node)
    expect(next.rpcFrames.map((frame) => frame.request.method)).toEqual(['system.hello'])
    await expect(rpc.call('tasks.list', {})).rejects.toMatchObject({ outcomeUnknown: false, code: 'connection-closed' })
  })

  it('does not label an interrupted read as a possibly completed write', async () => {
    const { node, tunnel } = await connected()
    const rpc = await desktop(node)
    const pending = rpc.call('tasks.list', {}).catch((error: unknown) => error)
    await flush()
    tunnel.receive(null)
    expect(await pending).toMatchObject({ outcomeUnknown: false, code: 'connection-closed' })
  })

  it('drops old session frames and lets an old adapter close without touching a new connection', async () => {
    const first = new Tunnel()
    first.ignoreClose = true
    const { node, dial } = await connected(first)
    const old = await desktop(node)
    const oldEvent = vi.fn()
    old.on('tasks.deleted', oldEvent)
    const next = new Tunnel()
    dial.mockResolvedValueOnce(next)
    await node.connect('Test browser')
    await old.closed
    const current = await desktop(node)
    const currentEvent = vi.fn()
    current.on('tasks.deleted', currentEvent)
    first.rpc({ jsonrpc: '2.0', method: 'tasks.deleted', params: { id: 'stale-task' } })
    await flush()
    expect(oldEvent).not.toHaveBeenCalled()
    expect(currentEvent).not.toHaveBeenCalled()
    old.close()
    expect(node.connected).toBe(true)
    next.rpc({ jsonrpc: '2.0', method: 'tasks.deleted', params: { id: 'current-task' } })
    await flush()
    expect(currentEvent).toHaveBeenCalledWith({ id: 'current-task' })
  })

  it('does not open a desktop stream after the catalog belongs to a disconnected generation', async () => {
    const { node, tunnel } = await connected()
    tunnel.onWrite = (frame) => {
      if (frame.kind === 'operation') queueMicrotask(() => node.disconnect())
    }
    await expect(connectDesktopRpc(node)).rejects.toMatchObject({ code: 'connection-closed' })
    expect(tunnel.frames.some((frame) => frame.kind === 'desktop')).toBe(false)
  })

  it('bounds an unanswered write and reports an unknown outcome without retrying it', async () => {
    const { node, tunnel } = await connected()
    const rpc = await desktop(node)
    const pending = rpc.call('conversations.interrupt', { id: conversationId }).catch((error: unknown) => error)
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await pending).toMatchObject({ code: 'request-timeout', outcomeUnknown: true })
    expect(tunnel.rpcFrames.filter((frame) => frame.request.method === 'conversations.interrupt')).toHaveLength(1)
    expect(node.connected).toBe(false)
  })

  it('rejects a request larger than the existing remote frame limit without closing the node', async () => {
    const { node, tunnel } = await connected()
    tunnel.methods.push('conversations.send')
    const rpc = await desktop(node)
    const count = tunnel.frames.length
    await expect(rpc.call('conversations.send', { id: conversationId, text: 'x'.repeat(65536) })).rejects.toMatchObject({ reason: 'request-too-large' })
    expect(tunnel.frames).toHaveLength(count)
    expect(node.connected).toBe(true)
  })

  it('limits a bootstrap burst to three in-flight RPCs and spaces sends by at least 50 ms', async () => {
    const { node, tunnel } = await connected()
    const rpc = await desktop(node)
    const sentAt: number[] = []
    tunnel.onWrite = (frame) => { if (frame.kind === 'rpc') sentAt.push(Date.now()) }
    const pending = Array.from({ length: 8 }, () => rpc.call('tasks.list', {}))
    await vi.advanceTimersByTimeAsync(1000)
    expect(tunnel.rpcFrames.filter((frame) => frame.request.method === 'tasks.list')).toHaveLength(3)
    for (let answered = 0; answered < 8; answered++) {
      const frame = tunnel.rpcFrames.filter((frame) => frame.request.method === 'tasks.list')[answered]
      expect(frame).toBeDefined()
      tunnel.rpc({ jsonrpc: '2.0', id: frame!.request.id, result: [] })
      await vi.advanceTimersByTimeAsync(50)
    }
    await expect(Promise.all(pending)).resolves.toHaveLength(8)
    expect(sentAt.every((at, index) => index === 0 || at - sentAt[index - 1]! >= 50)).toBe(true)
  })

  it('discards writes still queued when the node closes without marking them executed', async () => {
    const { node, tunnel } = await connected()
    const rpc = await desktop(node)
    const pending = Array.from({ length: 5 }, () => rpc.call('conversations.interrupt', { id: conversationId }).catch((error: unknown) => error))
    await vi.advanceTimersByTimeAsync(200)
    expect(tunnel.rpcFrames.filter((frame) => frame.request.method === 'conversations.interrupt')).toHaveLength(3)
    rpc.close()
    const failures = await Promise.all(pending)
    expect(failures.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ outcomeUnknown: true })))
    expect(failures.slice(3)).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ outcomeUnknown: false, code: 'request-not-sent' })))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(tunnel.rpcFrames.filter((frame) => frame.request.method === 'conversations.interrupt')).toHaveLength(3)
  })

  it('treats a malformed successful write response as an unknown result', async () => {
    const { node, tunnel } = await connected()
    const rpc = await desktop(node)
    tunnel.respond = ({ request }) => tunnel.rpc({ jsonrpc: '2.0', id: request.id, result: { unexpected: true } })
    await expect(rpc.call('conversations.interrupt', { id: conversationId })).rejects.toMatchObject({ code: 'invalid-response', outcomeUnknown: true })
  })
})
