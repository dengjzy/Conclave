import assert from 'node:assert/strict'
import { once } from 'node:events'
import { connect } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createGateway } from './gateway.mjs'

async function setup(t, options) {
  const gateway = await createGateway(options)
  t.after(() => gateway.close())
  return gateway
}

async function client(t, gateway) {
  const socket = connect(gateway.address)
  const messages = []
  const waiters = []
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let ended = false
  let sequence = 0
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk)
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(message)
      else messages.push(message)
    }
  })
  const closed = new Promise((resolve) => socket.on('close', () => {
    ended = true
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('connection closed'))
    resolve()
  }))
  await once(socket, 'connect')
  t.after(() => socket.destroy())
  const next = () => {
    if (messages.length) return Promise.resolve(messages.shift())
    if (ended) return Promise.reject(new Error('connection closed'))
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  }
  return {
    socket, closed, next,
    send(message) { socket.write(`${JSON.stringify({ id: String(++sequence), ...message })}\n`) },
    request(message) { this.send(message); return next() }
  }
}

async function pair(connection, gateway, deviceName = 'Test Android') {
  const { ticket } = gateway.createInvitation()
  const result = await connection.request({ kind: 'pair', ticket, deviceName })
  assert.equal(result.kind, 'paired')
  return result
}

test('one invitation has exactly one winner; its independent device token resumes after disconnect', { timeout: 3_000 }, async (t) => {
  const gateway = await setup(t)
  assert.equal(gateway.address.host, '127.0.0.1')
  const { ticket } = gateway.createInvitation()
  const clients = await Promise.all([client(t, gateway), client(t, gateway)])
  for (const connection of clients) connection.send({ kind: 'pair', ticket, deviceName: 'My phone' })
  const results = await Promise.all(clients.map((connection) => connection.next()))
  assert.equal(results.filter((result) => result.kind === 'paired').length, 1)
  assert.equal(results.filter((result) => result.code === 'invalid-invitation').length, 1)
  const winner = results.findIndex((result) => result.kind === 'paired')
  const paired = results[winner]
  assert.notEqual(paired.deviceToken, ticket)
  assert.equal(gateway.listDevices().length, 1)
  assert.deepEqual(Object.keys(gateway.listDevices()[0]).sort(), ['createdAt', 'id', 'lastSeenAt', 'name'])
  clients[winner].socket.destroy()
  await clients[winner].closed

  const resumed = await client(t, gateway)
  assert.equal((await resumed.request({ kind: 'resume', deviceId: paired.deviceId, deviceToken: paired.deviceToken })).kind, 'resumed')
  assert.equal((await resumed.request({ kind: 'ping' })).kind, 'pong')
  assert.equal((await resumed.request({ kind: 'echo', text: '手机连接成功' })).text, '手机连接成功')
  const reused = await client(t, gateway)
  assert.equal((await reused.request({ kind: 'pair', ticket, deviceName: 'Other phone' })).code, 'invalid-invitation')
})

test('expired invitations cannot pair, while expiry does not invalidate an already paired device', { timeout: 3_000 }, async (t) => {
  let clock = 1_000
  const gateway = await setup(t, { now: () => clock })
  const original = await client(t, gateway)
  const credentials = await pair(original, gateway)
  const invitation = gateway.createInvitation()
  assert.equal(invitation.expiresAt, clock + 300_000)
  clock = invitation.expiresAt
  const expired = await client(t, gateway)
  assert.equal((await expired.request({ kind: 'pair', ticket: invitation.ticket, deviceName: 'Late phone' })).code, 'invalid-invitation')
  const reconnect = await client(t, gateway)
  assert.equal((await reconnect.request({ kind: 'resume', deviceId: credentials.deviceId, deviceToken: credentials.deviceToken })).kind, 'resumed')
})

test('revoking a device disconnects all its sessions, aborts outstanding work, and rejects resuming', { timeout: 3_000 }, async (t) => {
  let coreStarted
  const started = new Promise((resolve) => { coreStarted = resolve })
  let observedSignal
  const gateway = await setup(t, {
    coreCall: (_method, { signal }) => new Promise((resolve, reject) => {
      observedSignal = signal
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      coreStarted()
    })
  })
  const first = await client(t, gateway)
  const credentials = await pair(first, gateway)
  const second = await client(t, gateway)
  await second.request({ kind: 'resume', deviceId: credentials.deviceId, deviceToken: credentials.deviceToken })
  second.send({ kind: 'core', method: 'tasks.list' })
  await started
  assert.equal(gateway.revoke(credentials.deviceId), true)
  await Promise.all([first.closed, second.closed])
  assert.equal(observedSignal.aborted, true)
  assert.deepEqual(gateway.listDevices(), [])
  assert.equal(gateway.revoke(credentials.deviceId), false)
  const reconnect = await client(t, gateway)
  assert.equal((await reconnect.request({ kind: 'resume', deviceId: credentials.deviceId, deviceToken: credentials.deviceToken })).code, 'unauthorized')
})

test('only authenticated, fixed read-only core methods cross the bridge; backend errors stay private', { timeout: 3_000 }, async (t) => {
  const calls = []
  const gateway = await setup(t, { coreCall: async (method) => {
    calls.push(method)
    if (method === 'system.hello') throw new Error('SECRET_CORE_TOKEN')
    return [{ id: 'test-task' }]
  } })
  const unauthenticated = await client(t, gateway)
  assert.equal((await unauthenticated.request({ kind: 'core', method: 'tasks.list' })).code, 'unauthenticated')
  assert.deepEqual(calls, [])
  const authorized = await client(t, gateway)
  await pair(authorized, gateway)
  assert.equal((await authorized.request({ kind: 'core', method: 'tasks.create' })).code, 'method-not-allowed')
  assert.deepEqual(calls, [])
  assert.deepEqual((await authorized.request({ kind: 'core', method: 'tasks.list' })).result, [{ id: 'test-task' }])
  const failed = await authorized.request({ kind: 'core', method: 'system.hello' })
  assert.equal(failed.code, 'core-error')
  assert.equal(JSON.stringify(failed).includes('SECRET_CORE_TOKEN'), false)
  assert.equal((await authorized.request({ kind: 'core', method: 'tasks.list', params: { injected: true } })).code, 'invalid-request')
  assert.deepEqual(calls, ['tasks.list', 'system.hello'])
})

test('frames can cross TCP chunks; malformed and oversized partial frames are rejected', { timeout: 3_000 }, async (t) => {
  const gateway = await setup(t)
  const fragmented = await client(t, gateway)
  const invitation = gateway.createInvitation()
  const frame = Buffer.from(`${JSON.stringify({ kind: 'pair', id: '1', ticket: invitation.ticket, deviceName: 'Android 📱' })}\n`)
  const split = frame.indexOf(Buffer.from('📱')) + 1
  fragmented.socket.write(frame.subarray(0, split))
  await delay(10)
  fragmented.socket.write(frame.subarray(split))
  assert.equal((await fragmented.next()).kind, 'paired')
  for (const bad of ['{broken}\n', '[]\n', Buffer.from([0xff, 10])]) {
    const connection = await client(t, gateway)
    connection.socket.write(bad)
    assert.match((await connection.next()).code, /^invalid-/)
    await connection.closed
  }
  const oversized = await client(t, gateway)
  oversized.socket.write(Buffer.alloc(64 * 1024 + 1, 65))
  assert.equal((await oversized.next()).code, 'frame-too-large')
  await oversized.closed
})

test('unauthenticated sockets and a stalled core call time out without exposing backend details', { timeout: 3_000 }, async (t) => {
  const gateway = await setup(t, {
    authTimeoutMs: 100,
    coreTimeoutMs: 50,
    coreCall: (_method, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('backend address and token')), { once: true })
    })
  })
  const abandoned = await client(t, gateway)
  assert.equal((await abandoned.next()).code, 'auth-timeout')
  await abandoned.closed
  const paired = await client(t, gateway)
  await pair(paired, gateway)
  assert.equal((await paired.request({ kind: 'core', method: 'tasks.list' })).code, 'core-timeout')
  assert.equal((await paired.request({ kind: 'ping' })).kind, 'pong')
})
