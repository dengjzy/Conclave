import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { PROTOCOL_VERSION, REMOTE_DESKTOP_METHODS, REMOTE_DESKTOP_WRITE_METHODS, RPC_ERROR, RpcFrame, remoteOperationSchemas, REMOTE_WRITE_METHODS, RemoteWireRequest, type RpcRequest, isRemoteDesktopMethod } from '@conclave/protocol'
import type { RemoteRpcSession } from './remote-rpc'
import { Rejection } from './rejection'
import { REMOTE_DEVICE_WRITE_LIMIT, type RemoteState } from './remote-state'

const MAX_INPUT = 64 * 1024
const MAX_OUTPUT = 4 * 1024 * 1024
const DEVICE_CACHE_BYTES = 1024 * 1024
const TOTAL_CACHE_BYTES = 16 * 1024 * 1024
const hash = (value: string) => createHash('sha256').update(value).digest()
const secret = () => randomBytes(32).toString('base64url')

export type RemoteCall = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>
export type GatewayDevice = { id: string; name: string; createdAt: number; lastSeenAt: number; online: boolean }
type Outcome = { ok: true; result: unknown } | { ok: false; code: string; message: string }
type WriteRecord = { fingerprint: string; pending: Promise<Outcome> | null; outcome: Outcome | null; bytes: number }
type Device = Omit<GatewayDevice, 'online'> & { tokenHash: Buffer; writes: Map<string, WriteRecord>; cacheBytes: number; controllers: Set<AbortController> }
type Operation = { method: string; params: unknown }
type Session = { desktop: RemoteRpcSession | null; rpcIds: Set<number>; device: Device | null; pending: Buffer; closing: boolean; reads: Set<AbortController>; window: number; frames: number }
export type RemoteGateway = {
  address: { host: string; port: number }
  createInvitation(): { ticket: string; expiresAt: number }
  listDevices(): GatewayDevice[]
  revoke(deviceId: string): boolean
  close(): Promise<void>
}

function rpcError(request: RpcRequest, reason: string, message: string): RpcFrame {
  return { jsonrpc: '2.0', id: request.id, error: { code: RPC_ERROR.rejected, message, data: { reason } } }
}

function fingerprint(value: unknown): string {
  const stable = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`
    if (item !== null && typeof item === 'object') return `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`
    return JSON.stringify(item) ?? 'null'
  }
  return hash(stable(value)).toString('hex')
}

export async function createRemoteGateway(options: {
  call: RemoteCall
  openDesktop?: (send: (frame: RpcFrame) => void) => RemoteRpcSession
  state?: RemoteState
  changed?: () => void
  now?: () => number
  invitationTtlMs?: number
  authTimeoutMs?: number
  idleTimeoutMs?: number
  operationTimeoutMs?: number
}): Promise<RemoteGateway> {
  const now = options.now ?? Date.now
  const devices = new Map<string, Device>()
  for (const device of options.state?.devices ?? []) devices.set(device.id, {
    ...device, tokenHash: Buffer.from(device.tokenHash, 'hex'), cacheBytes: 0, controllers: new Set(),
    writes: new Map(device.writes.map((write) => [write.requestId, { fingerprint: write.fingerprint, pending: null, bytes: 0,
      outcome: { ok: false, code: 'already-completed', message: '此操作已提交，主机重启后无法确认结果；请刷新状态，不要重新执行。' } }]))
  })
  let port = options.state?.port ?? 0
  const persist = () => options.state?.save(port, [...devices.values()].map((device) => ({
    id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt,
    tokenHash: device.tokenHash.toString('hex'),
    writes: [...device.writes].map(([requestId, record]) => ({ requestId, fingerprint: record.fingerprint }))
  })))
  const invitations = new Map<string, number>()
  const sessions = new Map<Socket, Session>()
  let activeCalls = 0
  let cacheBytes = 0
  let closing: Promise<void> | null = null
  let stopped = false
  const changed = () => options.changed?.()
  const pruneInvitations = () => { for (const [key, expiry] of invitations) if (expiry <= now()) invitations.delete(key) }

  function execute(operation: Operation, controller: AbortController, write: boolean, invoke?: (signal: AbortSignal) => Promise<unknown>): Promise<Outcome> {
    activeCalls++
    let complete: (outcome: Outcome) => void = () => {}
    let completed = false
    const outcome = new Promise<Outcome>((resolve) => { complete = resolve })
    const finish = (value: Outcome) => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', aborted)
      complete(value)
    }
    const aborted = () => finish({ ok: false, code: 'operation-cancelled', message: '操作已取消；已提交的更改不会回滚，请刷新确认。' })
    const timer = setTimeout(() => {
      finish({ ok: false, code: 'operation-timeout', message: '操作超时，请刷新状态确认结果，不要自动重试写操作。' })
      controller.abort()
    }, options.operationTimeoutMs ?? (write ? 120_000 : 30_000))
    timer.unref()
    controller.signal.addEventListener('abort', aborted, { once: true })
    if (controller.signal.aborted) aborted()
    // Keep the capacity occupied until the backend settles, even if it ignores cancellation.
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('cancelled')
      return invoke ? invoke(controller.signal) : options.call(operation.method, operation.params, controller.signal)
    }).then((result) => {
      // Transport availability belongs to this gateway, not the workspace action handler.
      if (operation.method === 'catalog') {
        const catalog = remoteOperationSchemas.catalog.result.safeParse(result)
        if (catalog.success) result = { ...catalog.data, capabilities: [
          ...(catalog.data.capabilities ?? []).filter((capability) => capability !== 'desktop-workspace'),
          ...(options.openDesktop ? ['desktop-workspace'] : [])
        ] }
      }
      finish({ ok: true, result })
    }, (error: unknown) => finish({ ok: false, code: error instanceof Rejection && /^[a-z0-9-]{1,80}$/.test(error.reason) ? error.reason : 'operation-failed', message: '操作未能完成，请在电脑端检查并刷新状态。' })).finally(() => { activeCalls-- })
    return outcome
  }

  const server = createServer((socket) => {
    if (stopped || sessions.size >= 32) { socket.destroy(); return }
    const session: Session = { desktop: null, rpcIds: new Set(), device: null, pending: Buffer.alloc(0), closing: false, reads: new Set(), window: now(), frames: 0 }
    sessions.set(socket, session)
    socket.setNoDelay(true)
    const authTimer = setTimeout(() => fail(undefined, 'auth-timeout', '配对或恢复连接超时。', true), options.authTimeoutMs ?? 10_000)
    authTimer.unref()
    socket.setTimeout(options.idleTimeoutMs ?? 60_000, () => fail(undefined, 'idle-timeout', '连接空闲超时，可以重新连接。', true))
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(authTimer)
      session.desktop?.close()
      for (const controller of session.reads) controller.abort()
      sessions.delete(socket)
      if (session.device) changed()
    })

    function send(message: unknown): boolean {
      if (session.closing || socket.destroyed) return false
      let frame: string
      try { frame = `${JSON.stringify(message)}\n` } catch { return false }
      const length = Buffer.byteLength(frame)
      if (length > MAX_OUTPUT) return false
      if (socket.writableLength + length > MAX_OUTPUT * 2) { socket.destroy(); return false }
      socket.write(frame)
      return true
    }

    function fail(id: string | undefined, code: string, message: string, disconnect = false): void {
      send({ kind: 'error', id, code, message })
      if (disconnect && !session.closing) {
        session.closing = true
        session.desktop?.close()
        for (const controller of session.reads) controller.abort()
        socket.end()
        const timer = setTimeout(() => socket.destroy(), 250)
        timer.unref()
        socket.once('close', () => clearTimeout(timer))
      }
    }

    function authenticate(device: Device): void {
      session.device = device
      device.lastSeenAt = now()
      clearTimeout(authTimer)
      changed()
    }

    function authorized(device: Device): boolean {
      return !session.closing && !stopped && devices.get(device.id) === device && session.device === device
    }

    function reply(id: string, device: Device, outcome: Outcome): void {
      if (!authorized(device)) return
      if (!outcome.ok) { fail(id, outcome.code, outcome.message); return }
      if (!send({ kind: 'operation', id, result: outcome.result })) fail(id, 'result-too-large', '结果超过实验通道上限，请缩小查询范围。')
    }

    function operate(id: string, requestId: string | undefined, operation: Operation, device: Device, desktop?: {
      write: boolean; invoke: (signal: AbortSignal) => Promise<unknown>; reply: (outcome: Outcome) => void
    }): void {
      const write = desktop?.write ?? REMOTE_WRITE_METHODS.some((method) => method === operation.method)
      const respond = (outcome: Outcome) => { if (authorized(device)) { if (desktop) desktop.reply(outcome); else reply(id, device, outcome) } }
      const reject = (code: string, message: string) => respond({ ok: false, code, message })
      if (write) {
        if (!requestId) { reject('request-id-required', '写操作必须携带独立的 requestId。'); return }
        const key = fingerprint(operation)
        const previous = device.writes.get(requestId)
        if (previous) {
          if (previous.fingerprint !== key) { reject('request-id-conflict', '相同 requestId 不能用于不同操作。'); return }
          if (previous.pending) void previous.pending.then((result) => respond(result))
          else if (previous.outcome) respond(previous.outcome)
          return
        }
        if (device.writes.size >= REMOTE_DEVICE_WRITE_LIMIT) { reject('request-limit', `此设备已达到 ${REMOTE_DEVICE_WRITE_LIMIT} 次写操作上限；请在电脑端撤销此设备后重新配对。旧请求的防重记录不会自动删除。`); return }
        if (device.controllers.size >= 4 || activeCalls >= 16) { reject('busy', '已有操作正在执行，请稍后再试。'); return }
        const controller = new AbortController()
        device.controllers.add(controller)
        const record: WriteRecord = { fingerprint: key, pending: null, outcome: null, bytes: 0 }
        // Register before yielding; reconnects share this result instead of executing again.
        device.writes.set(requestId, record)
        try { persist() } catch {
          device.controllers.delete(controller)
          // Keep the in-memory tombstone too: a failed fsync may still have renamed the file.
          record.outcome = { ok: false, code: 'storage-failed', message: '操作未执行：无法保存防重记录，请在电脑端检查存储。' }
          respond(record.outcome)
          return
        }
        record.pending = execute(operation, controller, write, desktop?.invoke)
        void record.pending.then((result) => {
          if (devices.get(device.id) === device) {
            let bytes = MAX_OUTPUT + 1
            try { bytes = Buffer.byteLength(JSON.stringify(result)) } catch {}
            if (device.cacheBytes + bytes <= DEVICE_CACHE_BYTES && cacheBytes + bytes <= TOTAL_CACHE_BYTES) {
              record.outcome = result
              record.bytes = bytes
              device.cacheBytes += bytes
              cacheBytes += bytes
            } else record.outcome = { ok: false, code: 'already-completed', message: '此操作已处理，结果未缓存；请刷新状态，不要重新执行。' }
          }
          record.pending = null
          device.controllers.delete(controller)
          respond(result)
        })
        return
      }
      if (session.reads.size >= 4 || activeCalls >= 16) { reject('busy', '已有查询正在执行，请稍后再试。'); return }
      const controller = new AbortController()
      session.reads.add(controller)
      void execute(operation, controller, write, desktop?.invoke).then((result) => {
        session.reads.delete(controller)
        respond(result)
      })
    }

    function handle(frame: Buffer): void {
      if (now() - session.window >= 1_000) { session.window = now(); session.frames = 0 }
      if (++session.frames > 32) { fail(undefined, 'rate-limited', '请求过于频繁。', true); return }
      let raw: unknown
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) } catch { fail(undefined, 'invalid-frame', '消息不是有效的 UTF-8 JSON。', true); return }
      const parsed = RemoteWireRequest.safeParse(raw)
      if (!parsed.success) { fail(undefined, 'invalid-request', '消息格式或操作参数无效。', true); return }
      const message = parsed.data
      if (message.kind === 'pair') {
        if (session.device) { fail(message.id, 'already-authenticated', '连接已经通过授权。'); return }
        pruneInvitations()
        const key = hash(message.ticket).toString('hex')
        if (!invitations.has(key)) { fail(message.id, 'invalid-invitation', '邀请已过期、已使用或不存在。', true); return }
        if (devices.size >= 64) { fail(message.id, 'device-limit', '请先移除已有设备。', true); return }
        invitations.delete(key)
        const token = secret()
        const device: Device = { id: randomUUID(), name: message.deviceName.trim(), createdAt: now(), lastSeenAt: now(), tokenHash: hash(token), writes: new Map(), cacheBytes: 0, controllers: new Set() }
        devices.set(device.id, device)
        try { persist() } catch {
          devices.delete(device.id)
          fail(message.id, 'storage-failed', '无法保存设备授权，请在电脑端检查存储后重新配对。', true)
          return
        }
        authenticate(device)
        send({ kind: 'paired', id: message.id, deviceId: device.id, deviceToken: token, ...options.state?.identity })
        return
      }
      if (message.kind === 'resume') {
        if (session.device) { fail(message.id, 'already-authenticated', '连接已经通过授权。'); return }
        const device = devices.get(message.deviceId)
        if (!device || !timingSafeEqual(device.tokenHash, hash(message.deviceToken))) { fail(message.id, 'unauthorized', '设备授权已失效，请重新配对。', true); return }
        authenticate(device)
        send({ kind: 'resumed', id: message.id, deviceId: device.id, ...options.state?.identity })
        return
      }
      const device = session.device
      const wireId = 'id' in message ? message.id : undefined
      if (!device || !authorized(device)) { fail(wireId, 'unauthenticated', '请先配对或恢复连接。', true); return }
      device.lastSeenAt = now()
      if (message.kind === 'desktop') {
        if (!options.openDesktop) { fail(message.id, 'desktop-unavailable', '此节点尚不支持桌面工作区。'); return }
        if (!session.desktop) {
          try {
            session.desktop = options.openDesktop((frame) => {
              if (authorized(device) && !send({ kind: 'rpc', frame })) socket.destroy()
            })
          } catch { fail(message.id, 'desktop-unavailable', '桌面工作区暂不可用。'); return }
        }
        send({ kind: 'desktop', id: message.id, protocolVersion: PROTOCOL_VERSION, methods: REMOTE_DESKTOP_METHODS })
      } else if (message.kind === 'rpc') {
        const request = message.request
        const respond = (frame: RpcFrame) => {
          if (authorized(device) && !send({ kind: 'rpc', frame })) {
            send({ kind: 'rpc', frame: rpcError(request, 'result-too-large', '结果超过远程通道上限，请缩小查询范围。') })
          }
        }
        if (!session.desktop) { respond(rpcError(request, 'desktop-required', '请先打开桌面工作区。')); return }
        if (!isRemoteDesktopMethod(request.method)) { respond(rpcError(request, 'remote-method-denied', '此操作需要在节点主机上完成。')); return }
        if (session.rpcIds.has(request.id)) { respond(rpcError(request, 'duplicate-request-id', '当前连接的请求编号不能重复。')); return }
        if (session.rpcIds.size >= 65_536) { fail(undefined, 'session-limit', '当前连接已达到请求上限，请重新连接。', true); return }
        session.rpcIds.add(request.id)
        const desktop = session.desktop
        operate(String(request.id), message.requestId, { method: `desktop:${request.method}`, params: request.params ?? {} }, device, {
          write: REMOTE_DESKTOP_WRITE_METHODS.some((method) => method === request.method),
          invoke: (signal) => desktop.request(request, signal, message.requestId),
          reply(outcome) {
            if (!outcome.ok) respond(rpcError(request, outcome.code, outcome.message))
            else respond({ ...RpcFrame.parse(outcome.result), id: request.id })
          }
        })
      } else if (message.kind === 'ping') send({ kind: 'pong', id: message.id, now: now() })
      else if (message.kind === 'operation') operate(message.id, message.requestId, message.operation, device)
    }

    socket.on('data', (chunk: Buffer) => {
      let offset = 0
      while (offset < chunk.length && !session.closing) {
        const newline = chunk.indexOf(10, offset)
        const part = chunk.subarray(offset, newline === -1 ? chunk.length : newline)
        if (session.pending.length + part.length > MAX_INPUT) { fail(undefined, 'frame-too-large', '消息超过 64 KiB。', true); return }
        session.pending = session.pending.length ? Buffer.concat([session.pending, part]) : Buffer.from(part)
        if (newline === -1) return
        const frame = session.pending
        session.pending = Buffer.alloc(0)
        handle(frame)
        offset = newline + 1
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('remote gateway did not bind TCP')
  port = address.port
  try { persist() } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }
  return {
    address: { host: '127.0.0.1', port: address.port },
    createInvitation() {
      if (stopped) throw new Error('remote gateway is closed')
      pruneInvitations()
      if (invitations.size >= 16) throw new Error('请等待已有二维码过期后再生成')
      const ticket = secret()
      const expiresAt = now() + (options.invitationTtlMs ?? 5 * 60_000)
      invitations.set(hash(ticket).toString('hex'), expiresAt)
      return { ticket, expiresAt }
    },
    listDevices() {
      return [...devices.values()].map((device) => ({ id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, online: [...sessions.values()].some((session) => session.device === device && !session.closing) }))
    },
    revoke(id) {
      const device = devices.get(id)
      if (!device) {
        try { persist() } catch { throw new Rejection('remote-storage-failed', '设备撤销记录未能保存，请修复电脑存储后再次撤销。') }
        return false
      }
      devices.delete(id)
      cacheBytes -= device.cacheBytes
      for (const controller of device.controllers) controller.abort()
      for (const [socket, session] of sessions) if (session.device === device) {
        session.closing = true
        session.desktop?.close()
        for (const controller of session.reads) controller.abort()
        socket.destroy()
      }
      try { persist() } catch { throw new Rejection('remote-storage-failed', '设备已断开，但撤销记录未能保存；请修复电脑存储后再次撤销。') }
      changed()
      return true
    },
    close() {
      if (closing) return closing
      stopped = true
      invitations.clear()
      for (const device of devices.values()) for (const controller of device.controllers) controller.abort()
      devices.clear()
      for (const [socket, session] of sessions) { session.closing = true; session.desktop?.close(); for (const controller of session.reads) controller.abort(); socket.destroy() }
      closing = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      return closing
    }
  }
}
