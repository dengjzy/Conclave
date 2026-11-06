import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteOperation, RemoteWireRequest } from '@conclave/protocol'
import type { MobileConnection } from './mobile-connection'
import type { MobilePlatform } from './mobile-platform'

const deviceId = '11111111-1111-4111-8111-111111111111'
const conversationId = '22222222-2222-4222-8222-222222222222'
const storageKey = 'conclave-mobile-device-v2'
const hostsKey = 'conclave-mobile-hosts-v3'
const activeKey = 'conclave-mobile-active-host-v3'
const saved = { address: 'test-tailcat-address', port: 443, deviceId, deviceToken: 'B'.repeat(43) }
const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class FakeTunnel {
  frames: RemoteWireRequest[] = []
  deviceToken = saved.deviceToken
  autoAuth = true
  closed = false
  ignoreClose = false
  onWrite: ((frame: RemoteWireRequest) => Promise<void>) | undefined
  private chunks: Array<Uint8Array | null> = []
  private reader: ((chunk: Uint8Array | null) => void) | undefined
  read(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift()
    if (chunk !== undefined) return Promise.resolve(chunk)
    if (this.closed && !this.ignoreClose) return Promise.resolve(null)
    return new Promise((resolve) => { this.reader = resolve })
  }
  write = vi.fn(async (bytes: Uint8Array) => {
    const frame = RemoteWireRequest.parse(JSON.parse(new TextDecoder().decode(bytes)))
    this.frames.push(frame)
    await this.onWrite?.(frame)
    if (this.autoAuth && frame.kind === 'resume') this.receive({ kind: 'resumed', id: frame.id, deviceId })
    if (this.autoAuth && frame.kind === 'pair') this.receive({ kind: 'paired', id: frame.id, deviceId, deviceToken: this.deviceToken })
    if (frame.kind === 'ping') this.receive({ kind: 'pong', id: frame.id, now: Date.now() })
  })
  close = vi.fn(() => { this.closed = true; if (!this.ignoreClose) this.receive(null) })
  receive(frame: object | null): void {
    const chunk = frame === null ? null : new TextEncoder().encode(JSON.stringify(frame) + '\n')
    if (this.reader) { const reader = this.reader; this.reader = undefined; reader(chunk) }
    else this.chunks.push(chunk)
  }
  get operations() { return this.frames.filter((frame) => frame.kind === 'operation') }
}

const clients: MobileConnection[] = []
const dial = vi.fn<(options: { addr: string; port: number }) => Promise<FakeTunnel>>()
const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }

async function client(platform?: MobilePlatform): Promise<MobileConnection> {
  const { MobileConnection } = await import('./mobile-connection')
  const connection = new MobileConnection(vi.fn(), platform)
  clients.push(connection)
  return connection
}
async function connected(tunnel = new FakeTunnel()): Promise<{ connection: MobileConnection; tunnel: FakeTunnel }> {
  dial.mockResolvedValueOnce(tunnel)
  const connection = await client()
  await connection.connect('test phone')
  return { connection, tunnel }
}
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }

async function catalog(connection: MobileConnection, tunnel: FakeTunnel, extra: { methods?: string[]; capabilities?: string[] } = {}) {
  const result = connection.call('catalog', {})
  await flush()
  tunnel.receive({ kind: 'operation', id: tunnel.operations.at(-1)?.id, result: { projects: [], agents: [{ id: 'codex', name: 'Codex' }], ...extra } })
  return result
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  dial.mockReset()
  storage.getItem.mockReset().mockImplementation((key: string) => key === storageKey ? JSON.stringify(saved) : null)
  storage.setItem.mockReset()
  storage.removeItem.mockReset()
  vi.stubGlobal('location', { hash: '', pathname: '/mobile/' })
  vi.stubGlobal('history', { replaceState: vi.fn() })
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('tailcatDial', dial)
  vi.stubGlobal('onTailcatReady', undefined)
  vi.stubGlobal('Go', class {
    importObject = {}
    run(): Promise<void> { globalThis.onTailcatReady?.(); return new Promise(() => {}) }
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(emptyWasm)))
})

afterEach(() => {
  for (const connection of clients.splice(0)) connection.disconnect()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MobileConnection', () => {
  it('keeps legacy task operations usable without probing unsupported conversation methods', async () => {
    const { connection, tunnel } = await connected()
    expect(connection.supports('conversations.create')).toBe(false)
    const old = await catalog(connection, tunnel)
    expect(old.capabilities).toBeUndefined()
    expect(connection.supports('tasks.page')).toBe(true)
    expect(connection.supports('tasks.create')).toBe(true)
    expect(connection.supports('conversations.send')).toBe(true)
    const frames = tunnel.operations.length
    await expect(connection.call('conversations.create', { agent: 'codex', projectPaths: [] })).rejects.toMatchObject({ code: 'unsupported-operation', outcomeUnknown: false })
    expect(tunnel.operations).toHaveLength(frames)
    expect(connection.connected).toBe(true)
    const page = connection.call('tasks.page', {})
    await flush()
    tunnel.receive({ kind: 'operation', id: tunnel.operations.at(-1)?.id, result: { items: [], total: 0, nextOffset: null } })
    await expect(page).resolves.toEqual({ items: [], total: 0, nextOffset: null })
  })

  it('negotiates methods independently of capability labels and accepts future catalog fields', async () => {
    const { connection, tunnel } = await connected()
    const result = await catalog(connection, tunnel, {
      capabilities: ['conversations', 'future-capability'], methods: ['catalog', 'conversations.page', 'future.method']
    })
    expect(result.capabilities).toContain('future-capability')
    expect(connection.supports('conversations.page')).toBe(true)
    expect(connection.supports('conversations.create')).toBe(false)
    expect(connection.supports('tasks.create')).toBe(false)
    const frames = tunnel.operations.length
    await expect(connection.call('conversations.create', { agent: 'codex', projectPaths: [] })).rejects.toMatchObject({ code: 'unsupported-operation', outcomeUnknown: false })
    expect(tunnel.operations).toHaveLength(frames)
    expect(connection.connected).toBe(true)
  })

  it('forgets negotiated methods on disconnect and restores legacy compatibility from the next catalog', async () => {
    const { connection, tunnel } = await connected()
    await catalog(connection, tunnel, { methods: ['catalog', 'conversations.create'] })
    expect(connection.supports('conversations.create')).toBe(true)
    connection.disconnect()
    expect(connection.supports('conversations.create')).toBe(false)
    const next = new FakeTunnel()
    dial.mockResolvedValueOnce(next)
    await connection.connect('second computer')
    await catalog(connection, next)
    expect(connection.supports('tasks.start')).toBe(true)
    expect(connection.supports('conversations.create')).toBe(false)
  })

  it('does not apply a catalog already received by a session that disconnects before its continuation', async () => {
    const { connection, tunnel } = await connected()
    const result = connection.call('catalog', {})
    await flush()
    tunnel.receive({ kind: 'operation', id: tunnel.operations.at(-1)?.id, result: { projects: [], agents: [], methods: ['catalog', 'conversations.create'] } })
    // The reader resolves the request; disconnect happens before call resumes and caches it.
    await Promise.resolve()
    connection.disconnect()
    await result
    const next = new FakeTunnel()
    dial.mockResolvedValueOnce(next)
    await connection.connect('another session')
    expect(connection.supports('conversations.create')).toBe(false)
    expect(connection.supports('tasks.page')).toBe(true)
  })

  it.each([
    { method: 'conversations.create', params: { agent: 'codex', projectPaths: [] } },
    { method: 'conversations.continue', params: { id: conversationId } },
    { method: 'conversations.setOption', params: { id: conversationId, option: 'model', value: 'test-model' } },
    { method: 'conversations.handoff', params: { id: conversationId, agent: 'claude', note: 'Review the result', stopRunning: false } },
    { method: 'tasks.handoff', params: { id: 'test-task', agent: 'claude', note: 'Continue this task' } },
    { method: 'agentCalls.dispatch', params: { id: conversationId, target: { agent: 'claude' }, instruction: 'Review without changing files', ref: '33333333-3333-4333-8333-333333333333' } },
    { method: 'agentCalls.cancel', params: { id: conversationId, callId: '33333333-3333-4333-8333-333333333333' } }
  ])('marks a sent $method as unknown after disconnect and never replays it', async (raw) => {
    const operation = RemoteOperation.parse(raw)
    const { connection, tunnel } = await connected()
    await catalog(connection, tunnel, { methods: ['catalog', operation.method] })
    const requestId = '44444444-4444-4444-8444-444444444444'
    const result = connection.call(operation.method, operation.params, requestId).catch((error: unknown) => error)
    await flush()
    expect(tunnel.operations.at(-1)).toMatchObject({ requestId, operation })
    tunnel.receive(null)
    await flush()
    expect(await result).toMatchObject({ outcomeUnknown: true, message: expect.stringContaining('结果未知') })
    const next = new FakeTunnel()
    dial.mockResolvedValueOnce(next)
    await connection.connect('phone')
    expect(next.frames.map((frame) => frame.kind)).toEqual(['resume'])
    expect(next.operations).toHaveLength(0)
  })

  it('does not send operations until authentication finishes', async () => {
    const tunnel = new FakeTunnel()
    tunnel.autoAuth = false
    dial.mockResolvedValue(tunnel)
    const connection = await client()
    await expect(connection.call('catalog', {})).rejects.toThrow('请先连接')
    const connecting = connection.connect('phone')
    await vi.waitFor(() => expect(tunnel.frames).toHaveLength(1))
    await expect(connection.call('conversations.interrupt', { id: conversationId })).rejects.toThrow('请先连接')
    expect(tunnel.operations).toHaveLength(0)
    tunnel.receive({ kind: 'resumed', id: tunnel.frames.find((frame) => frame.kind === 'resume')?.id, deviceId })
    await connecting
    expect(connection.connected).toBe(true)
  })

  it('cancels an old dial promptly and closes its late tunnel without disturbing the new session', async () => {
    const firstDial = deferred<FakeTunnel>()
    const firstTunnel = new FakeTunnel()
    const secondTunnel = new FakeTunnel()
    dial.mockReturnValueOnce(firstDial.promise).mockResolvedValueOnce(secondTunnel)
    const connection = await client()
    const first = connection.connect('first').catch((error: unknown) => error)
    await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(1))
    await connection.connect('second')
    expect(await first).toEqual(new Error('连接已取消'))
    firstDial.resolve(firstTunnel)
    await flush()
    expect(firstTunnel.close).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(45000)
    expect(connection.connected).toBe(true)
    expect(secondTunnel.close).not.toHaveBeenCalled()
  })

  it('ignores a stale reader and authentication completion after reconnect', async () => {
    const old = new FakeTunnel()
    old.autoAuth = false
    old.ignoreClose = true
    const fresh = new FakeTunnel()
    dial.mockResolvedValueOnce(old).mockResolvedValueOnce(fresh)
    const connection = await client()
    const first = connection.connect('first').catch((error: unknown) => error)
    await vi.waitFor(() => expect(old.frames).toHaveLength(1))
    await connection.connect('second')
    expect(await first).toBeInstanceOf(Error)
    // Even malformed bytes from an old socket cannot close its replacement.
    old.receive({ unexpected: true })
    await flush()
    expect(connection.connected).toBe(true)
    expect(fresh.close).not.toHaveBeenCalled()
  })

  it('closes a dial that arrives after its timeout', async () => {
    const pendingDial = deferred<FakeTunnel>()
    const tunnel = new FakeTunnel()
    dial.mockReturnValue(pendingDial.promise)
    const connection = await client()
    const result = connection.connect('phone').catch((error: unknown) => error)
    await vi.waitFor(() => expect(dial).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(45000)
    expect(await result).toEqual(new Error('连接超时，请确认电脑在线后重试'))
    pendingDial.resolve(tunnel)
    await flush()
    expect(tunnel.close).toHaveBeenCalled()
    expect(connection.connected).toBe(false)
  })

  it('reports a sent write as unknown on disconnect and never replays it', async () => {
    const { connection, tunnel } = await connected()
    const result = connection.call('conversations.interrupt', { id: conversationId }, '33333333-3333-4333-8333-333333333333').catch((error: unknown) => error)
    await flush()
    expect(tunnel.operations).toHaveLength(1)
    tunnel.receive(null)
    await flush()
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('结果未知') }))
    const next = new FakeTunnel()
    dial.mockResolvedValueOnce(next)
    await connection.connect('phone')
    expect(next.frames.map((frame) => frame.kind)).toEqual(['resume'])
  })

  it('treats a rejected transport write as unknown and stops the broken stream', async () => {
    const { connection, tunnel } = await connected()
    tunnel.onWrite = async () => { throw new Error('network lost after partial write') }
    await expect(connection.call('conversations.interrupt', { id: conversationId })).rejects.toThrow('结果未知')
    expect(connection.connected).toBe(false)
    expect(tunnel.close).toHaveBeenCalled()
  })

  it('reports a sent write timeout as unknown without resending it', async () => {
    const { connection, tunnel } = await connected()
    vi.clearAllTimers()
    const result = connection.call('conversations.interrupt', { id: conversationId }).catch((error: unknown) => error)
    await flush()
    await vi.advanceTimersByTimeAsync(120000)
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('结果未知') }))
    expect(tunnel.operations).toHaveLength(1)
  })

  it('never sends a queued write after it has expired', async () => {
    const { connection, tunnel } = await connected()
    vi.clearAllTimers()
    const barrier = deferred<void>()
    tunnel.onWrite = () => barrier.promise
    const blocked = connection.call('catalog', {}).catch((error: unknown) => error)
    const queued = connection.call('conversations.interrupt', { id: conversationId }).catch((error: unknown) => error)
    await flush()
    expect(tunnel.operations.map((frame) => frame.operation.method)).toEqual(['catalog'])
    await vi.advanceTimersByTimeAsync(120000)
    expect(await blocked).toBeInstanceOf(Error)
    expect(await queued).toMatchObject({ message: '操作尚未发送，请重新连接后重试', outcomeUnknown: false })
    barrier.resolve()
    await flush()
    expect(tunnel.operations.map((frame) => frame.operation.method)).toEqual(['catalog'])
  })

  it('keeps newly paired credentials in memory if browser storage fails', async () => {
    const invitation = { version: 2, address: saved.address, port: saved.port, ticket: 'A'.repeat(43), expiresAt: Date.now() + 60000 }
    vi.stubGlobal('location', { hash: '#pair=' + encodeURIComponent(JSON.stringify(invitation)), pathname: '/mobile/' })
    storage.getItem.mockReturnValue(null)
    storage.setItem.mockImplementation(() => { throw new Error('storage denied') })
    const { connection, tunnel } = await connected()
    expect(tunnel.frames[0]?.kind).toBe('pair')
    expect(connection.connected).toBe(true)
    expect(connection.isPairing).toBe(false)
    expect(connection.storageNotice).toContain('不能保存凭据')
    expect(storage.setItem).toHaveBeenCalledWith(hostsKey, expect.stringContaining(saved.deviceToken))
    connection.disconnect()
    const next = new FakeTunnel()
    dial.mockResolvedValueOnce(next)
    await connection.connect('phone')
    expect(next.frames[0]?.kind).toBe('resume')
    expect(connection.connected).toBe(true)
  })

  it('preserves an explicit server rejection instead of claiming the write succeeded', async () => {
    const { connection, tunnel } = await connected()
    const result = connection.call('conversations.interrupt', { id: conversationId })
    await flush()
    tunnel.receive({ kind: 'error', id: tunnel.operations[0]?.id, code: 'unauthorized', message: 'revoked' })
    await expect(result).rejects.toMatchObject({ message: expect.stringContaining('授权已失效'), code: 'unauthorized', outcomeUnknown: false })
  })

  it.each(['operation-timeout', 'operation-cancelled', 'operation-failed', 'already-completed', 'result-too-large'])('preserves the uncertain result of a server %s', async (code) => {
    const { connection, tunnel } = await connected()
    const result = connection.call('conversations.interrupt', { id: conversationId })
    await flush()
    tunnel.receive({ kind: 'error', id: tunnel.operations[0]?.id, code, message: 'refresh before retrying' })
    await expect(result).rejects.toMatchObject({ code, outcomeUnknown: true })
  })

  it('reports an invalid write result as unknown', async () => {
    const { connection, tunnel } = await connected()
    const result = connection.call('conversations.interrupt', { id: conversationId })
    await flush()
    tunnel.receive({ kind: 'operation', id: tunnel.operations[0]?.id, result: { wrong: true } })
    await expect(result).rejects.toThrow('结果未知')
  })
})


function memoryPlatform() {
  const values = new Map<string, string>()
  const preferences = new Map<string, string>()
  const platform: MobilePlatform = {
    credentials: {
      read: vi.fn(async (key: string) => values.get(key) ?? null),
      write: vi.fn(async (key: string, value: string | null) => {
        if (value === null) values.delete(key)
        else values.set(key, value)
        return true
      })
    },
    preferences: {
      read: (key) => preferences.get(key) ?? null,
      write: (key, value) => {
        if (value === null) preferences.delete(key)
        else preferences.set(key, value)
        return true
      }
    },
    takeInvitation: () => null,
    prepareNetwork: vi.fn(async () => {}),
    dial,
    isActive: () => true,
    subscribeActivity: () => () => {}
  }
  return { platform, values, preferences }
}

function invitationLink(address = saved.address, fields: object = {}): string {
  return 'https://example.com/mobile/#pair=' + encodeURIComponent(JSON.stringify({ version: 2, address, port: 443, ticket: crypto.randomUUID().replaceAll('-', '') + 'A'.repeat(11), expiresAt: Date.now() + 60000, ...fields }))
}

function storedHost(id = '44444444-4444-4444-8444-444444444444', name = '家里的电脑') {
  return { ...saved, id, name, deviceName: '我的手机', lastConnectedAt: 123 }
}

describe('mobile host library', () => {
  it('migrates the previous credential only after the new library is safely written', async () => {
    const { platform, values } = memoryPlatform()
    values.set(storageKey, JSON.stringify(saved))
    const connection = await client(platform)
    await connection.ready
    expect(connection.hosts).toEqual([{ id: expect.any(String), name: '我的电脑', deviceName: '手机浏览器', lastConnectedAt: null }])
    expect(connection.activeHostId).toBe(connection.hosts[0]?.id)
    expect(values.has(storageKey)).toBe(false)
    expect(JSON.parse(values.get(hostsKey) ?? '{}')).toMatchObject({ version: 3, hosts: [saved] })
    expect(connection.hosts[0]).not.toHaveProperty('deviceToken')
    expect(connection.hosts[0]).not.toHaveProperty('address')
  })

  it('keeps the previous credential when migration cannot persist', async () => {
    const { platform, values } = memoryPlatform()
    values.set(storageKey, JSON.stringify(saved))
    platform.credentials.write = vi.fn(async () => false)
    const connection = await client(platform)
    await connection.ready
    expect(connection.canConnect).toBe(true)
    expect(values.has(storageKey)).toBe(true)
    expect(connection.storageNotice).toContain('不能保存凭据')
  })

  it('restores the selected computer and ignores legacy data once a library exists', async () => {
    const { platform, values, preferences } = memoryPlatform()
    const first = storedHost()
    const second = { ...storedHost('55555555-5555-4555-8555-555555555555', '办公室'), address: 'office' }
    values.set(hostsKey, JSON.stringify({ version: 3, hosts: [first, second] }))
    values.set(storageKey, JSON.stringify(saved))
    preferences.set(activeKey, second.id)
    const connection = await client(platform)
    await connection.ready
    expect(connection.activeHostId).toBe(second.id)
    expect(connection.hostName).toBe('办公室')
    expect(connection.hosts).toHaveLength(2)
  })

  it('keeps pairings isolated, reuses a computer identity, and forgets only the selected computer', async () => {
    const { platform, values } = memoryPlatform()
    const connection = await client(platform)
    await connection.ready
    const first = new FakeTunnel()
    dial.mockResolvedValueOnce(first)
    connection.importInvitation(invitationLink('home'))
    await connection.connect('手机', '家里的电脑')
    const home = connection.activeHostId
    if (!home) throw new Error('missing host')
    const second = new FakeTunnel()
    second.deviceToken = 'C'.repeat(43)
    dial.mockResolvedValueOnce(second)
    connection.importInvitation(invitationLink('office'))
    expect(connection.activeHostId).toBeNull()
    expect(connection.hostName).toBe('')
    await connection.connect('手机', '办公室')
    expect(connection.hosts).toHaveLength(2)
    const office = connection.activeHostId
    if (!office) throw new Error('missing host')
    connection.selectHost(home)
    expect(second.closed).toBe(true)
    expect(connection.connected).toBe(false)
    const resumed = new FakeTunnel()
    dial.mockResolvedValueOnce(resumed)
    await connection.connect('手机')
    expect(resumed.frames[0]).toMatchObject({ kind: 'resume', deviceToken: saved.deviceToken })
    await connection.renameHost(home, '开发机')
    expect(connection.hostName).toBe('开发机')
    connection.importInvitation(invitationLink('home'))
    dial.mockResolvedValueOnce(new FakeTunnel())
    await connection.connect('另一手机')
    expect(connection.activeHostId).toBe(home)
    expect(connection.hostName).toBe('开发机')
    expect(connection.hosts).toHaveLength(2)
    connection.forget()
    await flush()
    expect(connection.hosts.map((host) => host.id)).toEqual([office])
    expect(connection.activeHostId).toBe(office)
    expect(JSON.parse(values.get(hostsKey) ?? '{}').hosts).toHaveLength(1)
    dial.mockResolvedValueOnce(new FakeTunnel())
    await connection.connect('手机')
    expect(dial).toHaveBeenLastCalledWith({ addr: 'office', port: 443 })
  })

  it('cancels a connection waiting on async credential initialization before it can dial', async () => {
    const { platform } = memoryPlatform()
    const reading = deferred<string | null>()
    platform.credentials.read = vi.fn(() => reading.promise)
    const connection = await client(platform)
    const connecting = connection.connect('phone').catch((error: unknown) => error)
    connection.disconnect()
    expect(await connecting).toEqual(new Error('连接已取消'))
    reading.resolve(JSON.stringify({ version: 3, hosts: [storedHost()] }))
    await connection.ready
    expect(dial).not.toHaveBeenCalled()
    expect(platform.prepareNetwork).not.toHaveBeenCalled()
    expect(connection.connected).toBe(false)
  })

  it('does not overwrite a newly imported invitation when async initialization finishes', async () => {
    const { platform } = memoryPlatform()
    const reading = deferred<string | null>()
    platform.credentials.read = vi.fn(() => reading.promise)
    const connection = await client(platform)
    connection.importInvitation(invitationLink('new-computer'))
    reading.resolve(JSON.stringify({ version: 3, hosts: [storedHost()] }))
    await connection.ready
    expect(connection.hosts).toHaveLength(1)
    expect(connection.activeHostId).toBeNull()
    expect(connection.isPairing).toBe(true)
    dial.mockResolvedValueOnce(new FakeTunnel())
    await connection.connect('phone')
    expect(dial).toHaveBeenCalledWith({ addr: 'new-computer', port: 443 })
    expect(connection.hosts).toHaveLength(2)
  })

  it('does not restore a computer forgotten before credential initialization completes', async () => {
    const { platform, values } = memoryPlatform()
    const reading = deferred<string | null>()
    platform.credentials.read = vi.fn(() => reading.promise)
    const connection = await client(platform)
    connection.forget()
    reading.resolve(JSON.stringify({ version: 3, hosts: [storedHost()] }))
    await connection.ready
    expect(connection.hosts).toEqual([])
    expect(connection.canConnect).toBe(false)
    expect(JSON.parse(values.get(hostsKey) ?? '{}').hosts).toEqual([])
  })

  it('forgets the previously selected host when initialization is still pending', async () => {
    const { platform, values, preferences } = memoryPlatform()
    const reading = deferred<string | null>()
    const first = storedHost()
    const second = { ...storedHost('55555555-5555-4555-8555-555555555555', '办公室'), address: 'office' }
    preferences.set(activeKey, second.id)
    platform.credentials.read = vi.fn(() => reading.promise)
    const connection = await client(platform)
    connection.forget()
    reading.resolve(JSON.stringify({ version: 3, hosts: [first, second] }))
    await connection.ready
    expect(connection.hosts.map((host) => host.id)).toEqual([first.id])
    expect(connection.activeHostId).toBe(first.id)
    expect(JSON.parse(values.get(hostsKey) ?? '{}').hosts[0].id).toBe(first.id)
  })

  it('discarding an invitation during initialization does not remove another saved computer', async () => {
    const { platform } = memoryPlatform()
    const reading = deferred<string | null>()
    platform.credentials.read = vi.fn(() => reading.promise)
    const connection = await client(platform)
    connection.importInvitation(invitationLink('new-computer'))
    connection.forget()
    reading.resolve(JSON.stringify({ version: 3, hosts: [storedHost()] }))
    await connection.ready
    expect(connection.hosts).toHaveLength(1)
    expect(connection.isPairing).toBe(false)
  })

  it('orders forgetting after an in-flight credential save and never revives its cancelled session', async () => {
    const { platform, values } = memoryPlatform()
    const saving = deferred<void>()
    const write = platform.credentials.write
    platform.credentials.write = vi.fn(async (key, value) => { await saving.promise; return write(key, value) })
    const connection = await client(platform)
    await connection.ready
    connection.importInvitation(invitationLink())
    dial.mockResolvedValueOnce(new FakeTunnel())
    const connecting = connection.connect('phone').catch((error: unknown) => error)
    await vi.waitFor(() => expect(platform.credentials.write).toHaveBeenCalled())
    connection.forget()
    expect(await connecting).toEqual(new Error('连接已取消'))
    saving.resolve()
    await flush()
    expect(connection.connected).toBe(false)
    expect(connection.hosts).toEqual([])
    expect(JSON.parse(values.get(hostsKey) ?? '{}').hosts).toEqual([])
  })

  it('retains a pairing for this session when a native credential store rejects its save', async () => {
    const { platform } = memoryPlatform()
    platform.credentials.write = vi.fn(async () => { throw new Error('keychain unavailable') })
    const connection = await client(platform)
    await connection.ready
    connection.importInvitation(invitationLink())
    dial.mockResolvedValueOnce(new FakeTunnel())
    await connection.connect('phone')
    expect(connection.connected).toBe(true)
    expect(connection.hosts).toHaveLength(1)
    expect(connection.storageNotice).toContain('不能保存凭据')
    connection.disconnect()
    const resumed = new FakeTunnel()
    dial.mockResolvedValueOnce(resumed)
    await connection.connect('phone')
    expect(resumed.frames[0]?.kind).toBe('resume')
  })

  it.each(['javascript:alert(1)', 'http://remote.example/mobile/#pair=bad', 'https://name:password@example.com/#pair=bad', '#pair={}&pair={}', '#pair={}&other=1', '{"version":2}'])('rejects invitation input without changing the active computer: %s', async (link) => {
    const { platform, values } = memoryPlatform()
    values.set(hostsKey, JSON.stringify({ version: 3, hosts: [storedHost()] }))
    const connection = await client(platform)
    await connection.ready
    expect(() => connection.importInvitation(link)).toThrow('配对链接无效')
    expect(connection.activeHostId).toBe(storedHost().id)
    expect(connection.isPairing).toBe(false)
  })

  it.each(['https://example.com/mobile/', 'http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://[::1]:5173/'])('imports a supported URL without navigating: %s', async (origin) => {
    const { platform } = memoryPlatform()
    const connection = await client(platform)
    await connection.ready
    const fragment = invitationLink().split('#')[1]
    connection.importInvitation(origin + '#' + fragment)
    expect(connection.isPairing).toBe(true)
    expect(dial).not.toHaveBeenCalled()
  })
})


describe('scanned node identity', () => {
  const nodeId = '77777777-7777-4777-8777-777777777777'
  function nodeTunnel(id = nodeId, name = 'Conclave 开发机') {
    const tunnel = new FakeTunnel()
    tunnel.autoAuth = false
    tunnel.onWrite = async (frame) => {
      if (frame.kind === 'pair') tunnel.receive({ kind: 'paired', id: frame.id, deviceId, deviceToken: saved.deviceToken, nodeId: id, nodeName: name })
      if (frame.kind === 'resume') tunnel.receive({ kind: 'resumed', id: frame.id, deviceId, nodeId: id, nodeName: name })
    }
    return tunnel
  }

  it('uses the authenticated node and native device names without manual input, then restores them', async () => {
    const { platform, values } = memoryPlatform()
    platform.deviceName = 'Pixel 测试机'
    const connection = await client(platform)
    await connection.ready
    const tunnel = nodeTunnel()
    dial.mockResolvedValueOnce(tunnel)
    const link = invitationLink(saved.address, { nodeId, nodeName: '二维码里的名称' })
    connection.importInvitation(link)
    expect(connection.invitationName).toBe('二维码里的名称')
    await connection.connect('')
    expect(tunnel.frames[0]).toMatchObject({ kind: 'pair', deviceName: 'Pixel 测试机' })
    expect(connection.hostName).toBe('Conclave 开发机')
    expect(JSON.parse(values.get(hostsKey) ?? '{}').hosts[0]).toMatchObject({ nodeId, name: 'Conclave 开发机' })
    expect(() => connection.importInvitation(link)).toThrow('已用于配对')
    expect(connection.connected).toBe(true)
    connection.disconnect()
    const restored = await client(platform)
    dial.mockResolvedValueOnce(nodeTunnel())
    await restored.connect('')
    expect(restored.hostName).toBe('Conclave 开发机')
    expect(restored.connected).toBe(true)
  })

  it('rejects expired scans before changing the existing connection', async () => {
    const { connection, tunnel } = await connected()
    const host = connection.activeHostId
    dial.mockClear()
    expect(() => connection.importInvitation(invitationLink('another', { expiresAt: Date.now() - 1 }))).toThrow('二维码已过期')
    expect(connection.activeHostId).toBe(host)
    expect(connection.connected).toBe(true)
    expect(tunnel.closed).toBe(false)
    expect(dial).not.toHaveBeenCalled()
  })

  it('checks expiration again after preparing the bundled network runtime', async () => {
    const { platform } = memoryPlatform()
    const preparing = deferred<void>()
    platform.prepareNetwork = () => preparing.promise
    const connection = await client(platform)
    connection.importInvitation(invitationLink())
    const attempt = connection.connect('phone').catch((error: unknown) => error)
    await flush()
    await vi.advanceTimersByTimeAsync(60001)
    preparing.resolve()
    expect(await attempt).toEqual(new Error('二维码已过期，请在电脑上重新生成'))
    expect(dial).not.toHaveBeenCalled()
  })

  it('rejects a node identity different from the QR before saving credentials or exposing operations', async () => {
    const { platform, values } = memoryPlatform()
    const connection = await client(platform)
    connection.importInvitation(invitationLink(saved.address, { nodeId }))
    dial.mockResolvedValueOnce(nodeTunnel('88888888-8888-4888-8888-888888888888'))
    await expect(connection.connect('phone')).rejects.toThrow('节点身份与二维码不一致')
    expect(connection.connected).toBe(false)
    expect(values.has(hostsKey)).toBe(false)
    await expect(connection.call('catalog', {})).rejects.toThrow('请先连接')
  })

  it('does not replace a saved cryptographic endpoint with a matching claimed node ID', async () => {
    const { platform, values } = memoryPlatform()
    values.set(hostsKey, JSON.stringify({ version: 3, hosts: [{ ...storedHost(), nodeId }] }))
    const connection = await client(platform)
    await connection.ready
    const host = connection.activeHostId
    expect(() => connection.importInvitation(invitationLink('different-key', { nodeId }))).toThrow('节点连接身份已变化')
    expect(connection.activeHostId).toBe(host)
    expect(dial).not.toHaveBeenCalled()
  })

  it('upgrades a legacy record at the same trusted endpoint without duplicating its name or ID', async () => {
    const { platform, values } = memoryPlatform()
    const legacy = storedHost()
    values.set(hostsKey, JSON.stringify({ version: 3, hosts: [legacy] }))
    const connection = await client(platform)
    await connection.ready
    connection.importInvitation(invitationLink(saved.address, { nodeId }))
    dial.mockResolvedValueOnce(nodeTunnel())
    await connection.connect('phone')
    expect(connection.hosts).toHaveLength(1)
    expect(connection.activeHostId).toBe(legacy.id)
    expect(connection.hostName).toBe(legacy.name)
    expect(JSON.parse(values.get(hostsKey) ?? '{}').hosts[0].nodeId).toBe(nodeId)
  })

  it('rejects a different node on resume and retains the saved record for explicit recovery', async () => {
    const { platform } = memoryPlatform()
    const connection = await client(platform)
    connection.importInvitation(invitationLink(saved.address, { nodeId }))
    dial.mockResolvedValueOnce(nodeTunnel())
    await connection.connect('phone')
    connection.disconnect()
    dial.mockResolvedValueOnce(nodeTunnel('88888888-8888-4888-8888-888888888888'))
    await expect(connection.connect('phone')).rejects.toThrow('节点身份已变化')
    expect(connection.connected).toBe(false)
    expect(connection.hosts).toHaveLength(1)
  })
})
