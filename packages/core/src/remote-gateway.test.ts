import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createRemoteGateway, type RemoteGateway } from './remote-gateway'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { REMOTE_DEVICE_WRITE_LIMIT, RemoteState } from './remote-state'
import { PROTOCOL_VERSION, REMOTE_DESKTOP_METHODS, RpcFrame } from '@conclave/protocol'
import { openRemoteRpcSession } from './remote-rpc'
import type { Connection } from './rpc-server'
import { Rejection } from './rejection'

const Wire = z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), kind: z.string(), frame: RpcFrame.optional(), methods: z.array(z.string()).optional(), protocolVersion: z.number().optional(), id: z.string().optional(), deviceId: z.string().optional(), deviceToken: z.string().optional(), code: z.string().optional(), result: z.unknown().optional() })
type Wire = z.infer<typeof Wire>
const gateways: RemoteGateway[] = []
const sockets: Socket[] = []
const directories: string[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup(options: Partial<Parameters<typeof createRemoteGateway>[0]> = {}) {
  const gateway = await createRemoteGateway({ call: async () => ({ ok: true }), ...options })
  gateways.push(gateway)
  return gateway
}

async function client(gateway: RemoteGateway) {
  const socket = connect(gateway.address)
  sockets.push(socket)
  const messages: Wire[] = []
  const waiting: { resolve(value: Wire): void; reject(error: Error): void }[] = []
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let ended = false
  let sequence = 0
  socket.on('error', () => {})
  socket.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = Wire.parse(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
      const waiter = waiting.shift()
      if (waiter) waiter.resolve(message)
      else messages.push(message)
    }
  })
  const closed = new Promise<void>((resolve) => socket.on('close', () => {
    ended = true
    for (const waiter of waiting.splice(0)) waiter.reject(new Error('closed'))
    resolve()
  }))
  await once(socket, 'connect')
  const next = () => {
    const message = messages.shift()
    if (message) return Promise.resolve(message)
    if (ended) return Promise.reject(new Error('closed'))
    return new Promise<Wire>((resolve, reject) => waiting.push({ resolve, reject }))
  }
  const send = (message: Record<string, unknown>) => socket.write(`${JSON.stringify({ id: String(++sequence), ...message })}\n`)
  return { socket, closed, next, send, request(message: Record<string, unknown>) { send(message); return next() } }
}

async function pair(connection: Awaited<ReturnType<typeof client>>, gateway: RemoteGateway) {
  const result = await connection.request({ kind: 'pair', ticket: gateway.createInvitation().ticket, deviceName: 'Android' })
  if (result.kind !== 'paired' || !result.deviceId || !result.deviceToken) throw new Error('pair failed')
  return { deviceId: result.deviceId, deviceToken: result.deviceToken }
}

const sendOperation = () => ({ method: 'conversations.send', params: { id: randomUUID(), text: 'hello', ref: randomUUID() } })

it('consumes invitations atomically and resumes paired devices after invitation expiry', async () => {
  let clock = 1_000
  const gateway = await setup({ now: () => clock })
  const invitation = gateway.createInvitation()
  const a = await client(gateway)
  const b = await client(gateway)
  a.send({ kind: 'pair', ticket: invitation.ticket, deviceName: 'A' })
  b.send({ kind: 'pair', ticket: invitation.ticket, deviceName: 'B' })
  const results = await Promise.all([a.next(), b.next()])
  const winner = results.find((result) => result.kind === 'paired')
  expect(results.filter((result) => result.kind === 'paired')).toHaveLength(1)
  expect(results.some((result) => result.code === 'invalid-invitation')).toBe(true)
  if (!winner?.deviceId || !winner.deviceToken) throw new Error('no winner')
  const expired = gateway.createInvitation()
  clock = expired.expiresAt
  const late = await client(gateway)
  expect((await late.request({ kind: 'pair', ticket: expired.ticket, deviceName: 'late' })).code).toBe('invalid-invitation')
  const resumed = await client(gateway)
  expect((await resumed.request({ kind: 'resume', deviceId: winner.deviceId, deviceToken: winner.deviceToken })).kind).toBe('resumed')
  expect(gateway.listDevices()).toMatchObject([{ online: true }])
  expect(JSON.stringify(gateway.listDevices())).not.toContain(winner.deviceToken)
})

it('executes a write once across disconnect, concurrent resume, and repeated request ids', async () => {
  let release: (value: unknown) => void = () => {}
  const call = vi.fn(() => new Promise((resolve) => { release = resolve }))
  const gateway = await setup({ call })
  const first = await client(gateway)
  const credentials = await pair(first, gateway)
  const requestId = randomUUID()
  const operation = sendOperation()
  first.send({ kind: 'operation', requestId, operation })
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
  first.socket.destroy()
  await first.closed
  const second = await client(gateway)
  await second.request({ kind: 'resume', ...credentials })
  second.send({ kind: 'operation', requestId, operation })
  await delay(10)
  expect(call).toHaveBeenCalledOnce()
  release({ ok: true })
  expect((await second.next()).result).toEqual({ ok: true })
  expect((await second.request({ kind: 'operation', requestId, operation })).result).toEqual({ ok: true })
  expect((await second.request({ kind: 'operation', requestId, operation: { ...operation, params: { ...operation.params, text: 'different' } } })).code).toBe('request-id-conflict')
  expect(call).toHaveBeenCalledOnce()
})

it('revocation cancels work, closes every device session, and rejects old credentials', async () => {
  let operationSignal: AbortSignal | null = null
  const call = vi.fn((_method: string, _params: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
    operationSignal = signal
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  const gateway = await setup({ call })
  const a = await client(gateway)
  const credentials = await pair(a, gateway)
  const b = await client(gateway)
  await b.request({ kind: 'resume', ...credentials })
  a.send({ kind: 'operation', requestId: randomUUID(), operation: sendOperation() })
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
  expect(gateway.revoke(credentials.deviceId)).toBe(true)
  await Promise.all([a.closed, b.closed])
  expect(operationSignal).toMatchObject({ aborted: true })
  expect(gateway.listDevices()).toEqual([])
  const revoked = await client(gateway)
  expect((await revoked.request({ kind: 'resume', ...credentials })).code).toBe('unauthorized')
})

it('rejects unauthenticated and non-allowlisted operations and never exposes arbitrary backend errors', async () => {
  const call = vi.fn(async () => { throw new Error('SECRET_TOKEN_IN_BACKEND_ERROR') })
  const gateway = await setup({ call })
  const unauth = await client(gateway)
  expect((await unauth.request({ kind: 'operation', operation: { method: 'catalog', params: {} } })).code).toBe('unauthenticated')
  const denied = await client(gateway)
  await pair(denied, gateway)
  expect((await denied.request({ kind: 'operation', operation: { method: 'tasks.delete', params: { id: randomUUID() } } })).code).toBe('invalid-request')
  expect(call).not.toHaveBeenCalled()
  const authorized = await client(gateway)
  await pair(authorized, gateway)
  expect((await authorized.request({ kind: 'operation', operation: sendOperation() })).code).toBe('request-id-required')
  const error = await authorized.request({ kind: 'operation', operation: { method: 'catalog', params: {} } })
  expect(error.code).toBe('operation-failed')
  expect(JSON.stringify(error)).not.toContain('SECRET_TOKEN')
  call.mockRejectedValueOnce(new Rejection('run-in-progress', 'private backend detail'))
  expect((await authorized.request({ kind: 'operation', operation: { method: 'catalog', params: {} } })).code).toBe('run-in-progress')
})

it('bounds input frames while accepting UTF-8 split across packets and large bounded responses', async () => {
  const gateway = await setup({ call: async () => ({ body: 'x'.repeat(100_000) }) })
  const connection = await client(gateway)
  const frame = Buffer.from(`${JSON.stringify({ kind: 'pair', id: '1', ticket: gateway.createInvitation().ticket, deviceName: '手机📱' })}\n`)
  const split = frame.indexOf(Buffer.from('📱')) + 1
  connection.socket.write(frame.subarray(0, split))
  await delay(10)
  connection.socket.write(frame.subarray(split))
  expect((await connection.next()).kind).toBe('paired')
  expect((await connection.request({ kind: 'operation', operation: { method: 'catalog', params: {} } })).result).toEqual({ body: 'x'.repeat(100_000) })
  for (const raw of [Buffer.from('{broken}\n'), Buffer.from([255, 10]), Buffer.alloc(65537, 65)]) {
    const invalid = await client(gateway)
    invalid.socket.write(raw)
    expect((await invalid.next()).code).toMatch(/^(invalid-frame|frame-too-large)$/)
    await invalid.closed
  }
})

it('retains deduplication records at capacity instead of evicting and repeating old writes', async () => {
  let clock = 1_000
  const call = vi.fn(async () => ({ ok: true }))
  const gateway = await setup({ call, now: () => clock })
  const connection = await client(gateway)
  await pair(connection, gateway)
  const operation = sendOperation()
  const first = randomUUID()
  for (let i = 0; i < REMOTE_DEVICE_WRITE_LIMIT; i++) {
    clock += 1_001
    expect((await connection.request({ kind: 'operation', requestId: i === 0 ? first : randomUUID(), operation })).kind).toBe('operation')
  }
  expect((await connection.request({ kind: 'operation', requestId: randomUUID(), operation })).code).toBe('request-limit')
  expect((await connection.request({ kind: 'operation', requestId: first, operation })).kind).toBe('operation')
  expect(call).toHaveBeenCalledTimes(REMOTE_DEVICE_WRITE_LIMIT)
})

it('times out stalled calls and keeps a timed-out write from being executed again', async () => {
  const call = vi.fn((_method: string, _params: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })))
  const gateway = await setup({ call, authTimeoutMs: 50, operationTimeoutMs: 30 })
  const abandoned = await client(gateway)
  expect((await abandoned.next()).code).toBe('auth-timeout')
  const connection = await client(gateway)
  await pair(connection, gateway)
  const request = { kind: 'operation', requestId: randomUUID(), operation: sendOperation() }
  expect((await connection.request(request)).code).toBe('operation-timeout')
  expect((await connection.request(request)).code).toBe('operation-timeout')
  expect(call).toHaveBeenCalledOnce()
})


it('restores identity, hashed authorization, fixed port and write tombstones after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-persist-'))
  directories.push(directory)
  const state = await RemoteState.open(directory)
  const call = vi.fn(async () => ({ done: true }))
  const first = await setup({ state, call })
  const connection = await client(first)
  const ticket = first.createInvitation().ticket
  const paired = await connection.request({ kind: 'pair', ticket, deviceName: 'Android' })
  expect(paired).toMatchObject({ kind: 'paired', ...state.identity })
  if (!paired.deviceId || !paired.deviceToken) throw new Error('pair failed')
  const credentials = { deviceId: paired.deviceId, deviceToken: paired.deviceToken }
  const requestId = randomUUID()
  const operation = sendOperation()
  expect((await connection.request({ kind: 'operation', requestId, operation })).result).toEqual({ done: true })
  const unconsumed = first.createInvitation()
  const saved = await readFile(path.join(directory, 'devices.json'), 'utf8')
  expect(saved).not.toContain(credentials.deviceToken)
  expect(saved).not.toContain(ticket)
  expect(saved).not.toContain(operation.params.text)
  expect(saved).toContain(requestId)
  expect((await stat(path.join(directory, 'devices.json'))).mode & 0o777).toBe(0o600)
  await first.close()
  const restoredState = await RemoteState.open(directory)
  const second = await setup({ state: restoredState, call })
  expect(second.address.port).toBe(first.address.port)
  expect(second.listDevices()).toMatchObject([{ id: credentials.deviceId, online: false }])
  const resumed = await client(second)
  expect(await resumed.request({ kind: 'resume', ...credentials })).toMatchObject({ kind: 'resumed', ...state.identity })
  expect((await resumed.request({ kind: 'operation', requestId, operation })).code).toBe('already-completed')
  expect((await resumed.request({ kind: 'operation', requestId, operation: { ...operation, params: { ...operation.params, text: 'different' } } })).code).toBe('request-id-conflict')
  expect(call).toHaveBeenCalledOnce()
  const stale = await client(second)
  expect((await stale.request({ kind: 'pair', ticket: unconsumed.ticket, deviceName: 'old invitation' })).code).toBe('invalid-invitation')
  second.revoke(credentials.deviceId)
  await second.close()
  const third = await setup({ state: await RemoteState.open(directory) })
  const revoked = await client(third)
  expect((await revoked.request({ kind: 'resume', ...credentials })).code).toBe('unauthorized')
})

it('does not execute writes if the durable dedupe record cannot be saved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-storage-'))
  directories.push(directory)
  const state = await RemoteState.open(directory)
  const call = vi.fn(async () => ({}))
  const gateway = await setup({ state, call })
  const connection = await client(gateway)
  await pair(connection, gateway)
  const save = vi.spyOn(state, 'save').mockImplementationOnce(() => { throw new Error('disk unavailable') })
  const message = { kind: 'operation', requestId: randomUUID(), operation: sendOperation() }
  expect((await connection.request(message)).code).toBe('storage-failed')
  expect((await connection.request(message)).code).toBe('storage-failed')
  expect(call).not.toHaveBeenCalled()
  save.mockRestore()
})

it('refuses to move a persisted gateway to another port when its port is occupied', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-port-'))
  directories.push(directory)
  const state = await RemoteState.open(directory)
  await setup({ state })
  await expect(createRemoteGateway({ state: await RemoteState.open(directory), call: async () => ({}) })).rejects.toMatchObject({ code: 'EADDRINUSE' })
})

it('deduplicates every newly exposed mutating action and never treats them as reads', async () => {
  const call = vi.fn(async (_method: string) => ({ ok: true }))
  let clock = 1_000
  const gateway = await setup({ call, now: () => clock })
  const connection = await client(gateway)
  await pair(connection, gateway)
  const id = randomUUID()
  const operations = [
    { method: 'conversations.create', params: { agent: 'codex', projectPaths: [] } },
    { method: 'conversations.continue', params: { id } },
    { method: 'conversations.setOption', params: { id, option: 'model', value: 'new-model' } },
    { method: 'conversations.handoff', params: { id, agent: 'claude', note: 'continue', stopRunning: false } },
    { method: 'tasks.handoff', params: { id, agent: 'claude', note: 'continue' } },
    { method: 'agentCalls.dispatch', params: { id, target: { agent: 'codex' }, instruction: 'inspect', ref: randomUUID() } },
    { method: 'agentCalls.cancel', params: { id, callId: randomUUID() } }
  ]
  for (const operation of operations) {
    clock += 1_001
    expect((await connection.request({ kind: 'operation', operation })).code).toBe('request-id-required')
    const request = { kind: 'operation', requestId: randomUUID(), operation }
    expect((await connection.request(request)).kind).toBe('operation')
    expect((await connection.request(request)).kind).toBe('operation')
  }
  expect(call).toHaveBeenCalledTimes(operations.length)
  expect(call.mock.calls.map((args) => args[0])).toEqual(operations.map((operation) => operation.method))
})

it('persists and reloads the expanded bounded write ledger without dropping old records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-capacity-'))
  directories.push(directory)
  const state = await RemoteState.open(directory)
  const writes = Array.from({ length: REMOTE_DEVICE_WRITE_LIMIT }, () => ({ requestId: randomUUID(), fingerprint: 'a'.repeat(64) }))
  const device = { id: randomUUID(), name: 'Android', createdAt: 1, lastSeenAt: 1, tokenHash: 'b'.repeat(64), writes }
  state.save(12345, [device])
  const restored = await RemoteState.open(directory)
  expect(restored.devices[0]?.writes).toEqual(writes)
  expect(() => restored.save(12345, [{ ...device, writes: [...writes, { requestId: randomUUID(), fingerprint: 'c'.repeat(64) }] }])).toThrow()
  expect((await RemoteState.open(directory)).devices[0]?.writes).toEqual(writes)
})


async function desktopFixture(extra: Partial<Parameters<typeof createRemoteGateway>[0]> = {}) {
  const connections = new Set<Connection>()
  const call = vi.fn(async (_method: string, _params: unknown, _signal: AbortSignal) => ({ ok: true }))
  const cleanup = vi.fn()
  const gateway = await setup({ call, openDesktop: (send) => openRemoteRpcSession({
    connections, send, call, closed: cleanup,
    dispatch(method, _params, connection) {
      if (method === 'conversations.watchChat') connection.watching.add('chat')
      return []
    }
  }), ...extra })
  return { gateway, connections, call, cleanup }
}

function sendRpc(connection: Awaited<ReturnType<typeof client>>, id: number, method: string, params: unknown = {}, requestId?: string) {
  connection.socket.write(`${JSON.stringify({ kind: 'rpc', requestId, request: { jsonrpc: '2.0', id, method, params } })}\n`)
}

it('requires pairing before opening desktop mode and keeps unsupported hosts usable for mobile', async () => {
  const { gateway } = await desktopFixture()
  const unauthenticated = await client(gateway)
  expect((await unauthenticated.request({ kind: 'desktop' })).code).toBe('unauthenticated')
  await unauthenticated.closed
  const mobileOnly = await setup()
  const connection = await client(mobileOnly)
  await pair(connection, mobileOnly)
  expect((await connection.request({ kind: 'desktop' })).code).toBe('desktop-unavailable')
  expect((await connection.request({ kind: 'ping' })).kind).toBe('pong')
})

it('negotiates an authenticated desktop session and revocation synchronously removes subscriptions', async () => {
  const { gateway, connections, cleanup } = await desktopFixture()
  const clientA = await client(gateway)
  const device = await pair(clientA, gateway)
  sendRpc(clientA, 0, 'tasks.list')
  expect((await clientA.next()).frame).toMatchObject({ error: { data: { reason: 'desktop-required' } } })
  const hello = await clientA.request({ kind: 'desktop' })
  expect(hello).toMatchObject({ kind: 'desktop', protocolVersion: PROTOCOL_VERSION, methods: [...REMOTE_DESKTOP_METHODS] })
  await clientA.request({ kind: 'desktop' })
  expect(connections.size).toBe(1)
  sendRpc(clientA, 1, 'conversations.watchChat', { id: randomUUID() })
  await clientA.next()
  const connection = [...connections][0]
  if (!connection) throw new Error('missing connection')
  expect(connection.watching.has('chat')).toBe(true)
  connection.notify('conversations.chatDelta', { conversationId: 'chat', itemId: 'reply', append: 'hello' })
  expect((await clientA.next()).frame).toMatchObject({ method: 'conversations.chatDelta', params: { append: 'hello' } })
  gateway.revoke(device.deviceId)
  expect(connections.size).toBe(0)
  expect(cleanup).toHaveBeenCalledOnce()
  await clientA.closed
})

it('deduplicates desktop writes across reconnect while returning the new JSON-RPC id', async () => {
  const { gateway, call } = await desktopFixture()
  const first = await client(gateway)
  const device = await pair(first, gateway)
  await first.request({ kind: 'desktop' })
  const requestId = randomUUID()
  const params = { id: randomUUID(), text: 'one message' }
  sendRpc(first, 10, 'conversations.send', params, requestId)
  expect((await first.next()).frame).toMatchObject({ id: 10, result: { ok: true } })
  first.socket.destroy()
  await first.closed
  const second = await client(gateway)
  await second.request({ kind: 'resume', ...device })
  await second.request({ kind: 'desktop' })
  sendRpc(second, 30, 'conversations.send', params, requestId)
  expect((await second.next()).frame).toMatchObject({ id: 30, result: { ok: true } })
  sendRpc(second, 31, 'conversations.send', { ...params, text: 'different message' }, requestId)
  expect((await second.next()).frame).toMatchObject({ id: 31, error: { data: { reason: 'request-id-conflict' } } })
  sendRpc(second, 32, 'conversations.send', params)
  expect((await second.next()).frame).toMatchObject({ id: 32, error: { data: { reason: 'request-id-required' } } })
  expect(call).toHaveBeenCalledTimes(1)
  expect(call).toHaveBeenCalledWith('conversations.send', { ...params, ref: requestId }, expect.any(AbortSignal))
})

it('blocks unsupported desktop methods and duplicate wire ids without dispatching any write', async () => {
  const { gateway, call } = await desktopFixture()
  const connection = await client(gateway)
  await pair(connection, gateway)
  await connection.request({ kind: 'desktop' })
  for (const [id, method] of ['files.read', 'files.write', 'git.execute', 'sessions.write', 'remote.createInvitation'].entries()) {
    sendRpc(connection, id, method, {}, randomUUID())
    expect((await connection.next()).frame).toMatchObject({ id, error: { data: { reason: 'remote-method-denied' } } })
  }
  sendRpc(connection, 20, 'tasks.list')
  await connection.next()
  sendRpc(connection, 20, 'tasks.list')
  expect((await connection.next()).frame).toMatchObject({ error: { data: { reason: 'duplicate-request-id' } } })
  expect(call).not.toHaveBeenCalled()
})

it('keeps the existing 64 KiB input cap after desktop negotiation', async () => {
  const { gateway, connections } = await desktopFixture()
  const connection = await client(gateway)
  await pair(connection, gateway)
  await connection.request({ kind: 'desktop' })
  sendRpc(connection, 1, 'conversations.send', { id: randomUUID(), text: 'x'.repeat(65_536) }, randomUUID())
  expect((await connection.next()).code).toBe('frame-too-large')
  await connection.closed
  expect(connections.size).toBe(0)
})

it('closes an overflowing desktop notification stream instead of silently losing live state', async () => {
  const { gateway, connections } = await desktopFixture()
  const clientA = await client(gateway)
  await pair(clientA, gateway)
  await clientA.request({ kind: 'desktop' })
  const connection = [...connections][0]
  if (!connection) throw new Error('missing connection')
  connection.notify('conversations.chatDelta', { conversationId: 'chat', itemId: 'message', append: 'x'.repeat(4 * 1024 * 1024) })
  await clientA.closed
  expect(connections.size).toBe(0)
})


it('advertises desktop availability only when this gateway can open a desktop session', async () => {
  const claimed = { projects: [], agents: [], capabilities: ['conversations', 'desktop-workspace'] }
  const mobile = await setup({ call: async () => claimed })
  const mobileClient = await client(mobile)
  await pair(mobileClient, mobile)
  expect((await mobileClient.request({ kind: 'operation', operation: { method: 'catalog', params: {} } })).result).toMatchObject({ capabilities: ['conversations'] })
  const { gateway } = await desktopFixture({ call: async () => ({ projects: [], agents: [], capabilities: ['conversations'] }) })
  const desktopClient = await client(gateway)
  await pair(desktopClient, gateway)
  expect((await desktopClient.request({ kind: 'operation', operation: { method: 'catalog', params: {} } })).result).toMatchObject({ capabilities: ['conversations', 'desktop-workspace'] })
})
