import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'

export const READ_ONLY_CORE_METHODS = Object.freeze(['system.hello', 'tasks.list'])
const MAX_FRAME_BYTES = 64 * 1024
const MAX_CONNECTIONS = 32
const MAX_DEVICES = 64
const MAX_INVITATIONS = 16
const digest = (value) => createHash('sha256').update(value).digest()
const secret = () => randomBytes(32).toString('base64url')
const isSecret = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key))

function positiveDuration(value, fallback) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('invalid timeout')
  return result
}

/** Experimental NDJSON gateway. Device credentials intentionally live only until close/restart. */
export async function createGateway(options = {}) {
  const invitationTtlMs = positiveDuration(options.invitationTtlMs, 5 * 60_000)
  const authTimeoutMs = positiveDuration(options.authTimeoutMs, 10_000)
  const idleTimeoutMs = positiveDuration(options.idleTimeoutMs, 60_000)
  const coreTimeoutMs = positiveDuration(options.coreTimeoutMs, 5_000)
  const now = options.now ?? Date.now
  const invitations = new Map()
  const devices = new Map()
  const sessions = new Map()
  let coreCalls = 0
  let closed = false
  let closing

  function pruneInvitations() {
    for (const [key, expiresAt] of invitations) if (expiresAt <= now()) invitations.delete(key)
  }

  const server = createServer((socket) => {
    if (closed || sessions.size >= MAX_CONNECTIONS) {
      socket.destroy()
      return
    }
    const session = { deviceId: null, pending: Buffer.alloc(0), closing: false, core: null, frames: 0, window: now() }
    sessions.set(socket, session)
    socket.setNoDelay(true)
    const authTimer = setTimeout(() => fail(null, 'auth-timeout', 'Pairing or resume timed out.', true), authTimeoutMs)
    authTimer.unref()
    socket.setTimeout(idleTimeoutMs, () => fail(null, 'idle-timeout', 'Connection was idle.', true))
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(authTimer)
      session.core?.abort()
      sessions.delete(socket)
    })

    function send(message) {
      if (session.closing || socket.destroyed) return false
      let frame
      try { frame = `${JSON.stringify(message)}\n` } catch { return false }
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return false
      if (socket.writableLength + Buffer.byteLength(frame) > MAX_FRAME_BYTES * 4) {
        socket.destroy()
        return false
      }
      socket.write(frame)
      return true
    }

    function fail(id, code, message, disconnect = false) {
      send({ kind: 'error', ...(id ? { id } : {}), code, message })
      if (disconnect && !session.closing) {
        session.closing = true
        socket.end()
        const timer = setTimeout(() => socket.destroy(), 250)
        timer.unref()
        socket.once('close', () => clearTimeout(timer))
      }
    }

    function authenticated() {
      return session.deviceId !== null && devices.has(session.deviceId)
    }

    function authenticate(id) {
      session.deviceId = id
      clearTimeout(authTimer)
      devices.get(id).lastSeenAt = now()
    }

    function readCore(message) {
      if (!READ_ONLY_CORE_METHODS.includes(message.method)) {
        fail(message.id, 'method-not-allowed', 'Only the advertised read-only methods are available.')
        return
      }
      if (!options.coreCall) {
        fail(message.id, 'core-unavailable', 'No test core is connected.')
        return
      }
      if (session.core || coreCalls >= 8) {
        fail(message.id, 'busy', 'A core request is already in progress.')
        return
      }
      const controller = new AbortController()
      session.core = controller
      coreCalls++
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        controller.abort()
        fail(message.id, 'core-timeout', 'The test core did not respond in time.')
      }, coreTimeoutMs)
      timer.unref()
      Promise.resolve().then(() => options.coreCall(message.method, { signal: controller.signal })).then((result) => {
        if (!expired && authenticated()) {
          if (!send({ kind: 'core', id: message.id, method: message.method, result })) {
            fail(message.id, 'result-too-large', 'The core result cannot fit in one experimental frame.')
          }
        }
      }, () => {
        if (!expired) fail(message.id, 'core-error', 'The test core request failed.')
      }).finally(() => {
        clearTimeout(timer)
        coreCalls--
        session.core = null
      })
    }

    function handle(frame) {
      if (now() - session.window >= 1_000) { session.frames = 0; session.window = now() }
      if (++session.frames > 32) { fail(null, 'rate-limited', 'Too many messages.', true); return }
      let message
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) } catch {
        fail(null, 'invalid-frame', 'Expected a UTF-8 JSON object.', true)
        return
      }
      if (!isRecord(message) || !isId(message.id) || typeof message.kind !== 'string') {
        fail(null, 'invalid-request', 'Expected an object with a short string id and kind.', true)
        return
      }
      const invalid = () => fail(message.id, 'invalid-request', 'Invalid request fields.', true)
      if (message.kind === 'pair') {
        if (!hasKeys(message, ['kind', 'id', 'ticket', 'deviceName']) || !isSecret(message.ticket) || typeof message.deviceName !== 'string' || !message.deviceName.trim() || message.deviceName.length > 80) { invalid(); return }
        if (authenticated()) { fail(message.id, 'already-authenticated', 'This connection is already paired.'); return }
        pruneInvitations()
        const key = digest(message.ticket).toString('hex')
        if (!invitations.has(key)) { fail(message.id, 'invalid-invitation', 'The invitation is expired, consumed, or unknown.', true); return }
        if (devices.size >= MAX_DEVICES) { fail(message.id, 'device-limit', 'Remove an existing device before pairing another.', true); return }
        // Consume synchronously before any work can yield to a competing connection.
        invitations.delete(key)
        const deviceId = randomUUID()
        const deviceToken = secret()
        devices.set(deviceId, { id: deviceId, name: message.deviceName.trim(), createdAt: now(), lastSeenAt: now(), tokenHash: digest(deviceToken) })
        authenticate(deviceId)
        send({ kind: 'paired', id: message.id, deviceId, deviceToken })
        return
      }
      if (message.kind === 'resume') {
        if (!hasKeys(message, ['kind', 'id', 'deviceId', 'deviceToken']) || !isId(message.deviceId) || !isSecret(message.deviceToken)) { invalid(); return }
        if (authenticated()) { fail(message.id, 'already-authenticated', 'This connection is already paired.'); return }
        const device = devices.get(message.deviceId)
        const given = digest(message.deviceToken)
        if (!device || !timingSafeEqual(device.tokenHash, given)) { fail(message.id, 'unauthorized', 'Device authorization failed.', true); return }
        authenticate(device.id)
        send({ kind: 'resumed', id: message.id, deviceId: device.id })
        return
      }
      if (!authenticated()) { fail(message.id, 'unauthenticated', 'Pair or resume before sending requests.', true); return }
      devices.get(session.deviceId).lastSeenAt = now()
      if (message.kind === 'ping') {
        if (!hasKeys(message, ['kind', 'id'])) { invalid(); return }
        send({ kind: 'pong', id: message.id, now: now() })
      } else if (message.kind === 'echo') {
        if (!hasKeys(message, ['kind', 'id', 'text']) || typeof message.text !== 'string' || Buffer.byteLength(message.text) > 16 * 1024) { invalid(); return }
        send({ kind: 'echo', id: message.id, text: message.text })
      } else if (message.kind === 'core') {
        if (!hasKeys(message, ['kind', 'id', 'method']) || typeof message.method !== 'string') { invalid(); return }
        readCore(message)
      } else {
        fail(message.id, 'unknown-kind', 'Unknown experimental message kind.')
      }
    }

    socket.on('data', (chunk) => {
      let offset = 0
      while (offset < chunk.length && !session.closing) {
        const newline = chunk.indexOf(10, offset)
        const end = newline === -1 ? chunk.length : newline
        const part = chunk.subarray(offset, end)
        if (session.pending.length + part.length > MAX_FRAME_BYTES) { fail(null, 'frame-too-large', 'Frame exceeds 64 KiB.', true); return }
        session.pending = session.pending.length ? Buffer.concat([session.pending, part]) : Buffer.from(part)
        if (newline === -1) return
        const frame = session.pending
        session.pending = Buffer.alloc(0)
        handle(frame)
        offset = newline + 1
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = Object.freeze({ host: '127.0.0.1', port: server.address().port })
  return {
    address,
    createInvitation() {
      if (closed) throw new Error('gateway is closed')
      pruneInvitations()
      if (invitations.size >= MAX_INVITATIONS) throw new Error('too many outstanding invitations')
      const ticket = secret()
      const expiresAt = now() + invitationTtlMs
      invitations.set(digest(ticket).toString('hex'), expiresAt)
      return { ticket, expiresAt }
    },
    listDevices() {
      return [...devices.values()].map(({ tokenHash: _tokenHash, ...device }) => ({ ...device }))
    },
    revoke(id) {
      if (!devices.delete(id)) return false
      for (const [socket, session] of sessions) {
        if (session.deviceId === id) { session.closing = true; session.core?.abort(); socket.destroy() }
      }
      return true
    },
    close() {
      if (!closing) {
        closed = true
        invitations.clear()
        devices.clear()
        for (const [socket, session] of sessions) { session.closing = true; session.core?.abort(); socket.destroy() }
        closing = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      }
      return closing
    }
  }
}
