import { z } from 'zod'
import { REMOTE_WRITE_METHODS, RemotePairingPayload, RemoteWireResponse, remoteOperationSchemas, type RemoteMethod, type RemoteParams, type RemoteResult, RpcRequest, type RpcFrame } from '@conclave/protocol'
import { createBrowserNodePlatform, type NodePlatform, type NodeTunnel } from './node-platform'

const SavedDevice = z.object({ address: z.string().min(1), port: z.number().int().min(1).max(65535), deviceId: z.string().uuid(), deviceToken: z.string().min(1), nodeId: z.string().uuid().optional() })
const SavedHost = SavedDevice.extend({ id: z.string().uuid(), name: z.string().min(1).max(80), deviceName: z.string().min(1).max(80), lastConnectedAt: z.number().nonnegative().nullable() })
const HostLibrary = z.object({ version: z.literal(3), hosts: z.array(SavedHost) })
type SavedHost = z.infer<typeof SavedHost>
export type NodeHost = Readonly<Pick<SavedHost, 'id' | 'name' | 'deviceName' | 'lastConnectedAt' | 'nodeId'>>
export interface NodeRpcTransport {
  protocolVersion: number
  methods: readonly string[]
  send(request: z.infer<typeof RpcRequest>): Promise<void>
  onFrame(listener: (frame: RpcFrame) => void): () => void
  closed: Promise<void>
  close(): void
}
type DesktopSession = { receive(frame: RpcFrame): void; close(): void }
type Pending = { resolve: (frame: RemoteWireResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; write: boolean; sent: boolean }
const STORAGE_KEY = 'conclave-mobile-hosts-v3'
const LEGACY_STORAGE_KEY = 'conclave-mobile-device-v2'
const ACTIVE_HOST_KEY = 'conclave-mobile-active-host-v3'
const STORAGE_NOTICE = '此设备不能保存凭据，关闭后需要重新扫码'
const WRITE_UNKNOWN = '操作结果未知，请重新连接并刷新会话或任务确认，勿重复提交'
const LEGACY_METHODS = ['catalog', 'tasks.page', 'tasks.get', 'tasks.create', 'tasks.start', 'tasks.resumeChat', 'conversations.get', 'chat.page', 'conversations.send', 'conversations.interrupt', 'conversations.respond'] as const
const INVALID_INVITATION = '配对链接无效，请在电脑上重新生成'

export class NodeRequestError extends Error {
  constructor(message: string, readonly code: string | null = null, readonly outcomeUnknown = false) {
    super(message)
    this.name = 'NodeRequestError'
  }
}

function parseInvitation(link: string): RemotePairingPayload {
  const input = link.trim()
  if (input.length > 16384) throw new Error(INVALID_INVITATION)
  let fragment = input
  if (!input.startsWith('#')) {
    const url = new URL(input)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error(INVALID_INVITATION)
    fragment = url.hash
  }
  const params = new URLSearchParams(fragment.slice(1))
  if (!fragment.startsWith('#pair=') || [...params.keys()].length !== 1 || !params.has('pair')) throw new Error(INVALID_INVITATION)
  return RemotePairingPayload.parse(JSON.parse(params.get('pair') ?? ''))
}

export class NodeConnection {
  private invitation: RemotePairingPayload | null = null
  private redeemedTickets = new Map<string, number>()
  private records: SavedHost[] = []
  private selectedHostId: string | null = null
  private selectionRevision = 0
  private forgetInitialHost = false
  private initialized = false
  private saving = Promise.resolve(true)
  private connection: NodeTunnel | null = null
  private generation = 0
  private nextId = 0
  private methods = new Set<string>(LEGACY_METHODS)
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private cancelConnect: (() => void) | null = null
  private queue = Promise.resolve()
  private pending = new Map<string, Pending>()
  private desktop: DesktopSession | null = null
  readonly ready: Promise<void>
  connected = false
  storageNotice = ''
  invitationProblem = ''

  constructor(private readonly changed: (message: string) => void, readonly platform: NodePlatform = createBrowserNodePlatform()) {
    const initial = platform.takeInvitation()
    if (initial) {
      try { this.invitation = parseInvitation(initial) }
      catch { this.invitationProblem = INVALID_INVITATION }
    }
    this.ready = this.initialize()
  }

  get hosts(): readonly NodeHost[] {
    return this.records.map(({ id, name, deviceName, lastConnectedAt, nodeId }) => ({ id, name, deviceName, lastConnectedAt, nodeId }))
  }
  supports(method: RemoteMethod): boolean { return this.methods.has(method) }
  get connectionRevision(): number { return this.generation }
  get nodeId(): string | null { return this.saved?.nodeId ?? null }
  get activeHostId(): string | null { return this.selectedHostId }
  get hostName(): string { return this.saved?.name ?? '' }
  get invitationName(): string { return this.invitation?.nodeName ?? '' }
  private get saved(): SavedHost | null { return this.records.find((host) => host.id === this.selectedHostId) ?? null }
  get canConnect(): boolean { return Boolean(this.invitation || this.saved) }
  get isPairing(): boolean { return Boolean(this.invitation) }

  private async initialize(): Promise<void> {
    const revision = this.selectionRevision
    const preferred = this.platform.preferences.read(ACTIVE_HOST_KEY)
    let migrated = false
    try {
      const stored = await this.platform.credentials.read(STORAGE_KEY)
      if (stored) {
        const library = HostLibrary.parse(JSON.parse(stored))
        const ids = new Set<string>()
        const endpoints = new Set<string>()
        this.records = library.hosts.filter((host) => {
          const endpoint = host.nodeId ?? JSON.stringify([host.address, host.port])
          if (ids.has(host.id) || endpoints.has(endpoint)) return false
          ids.add(host.id); endpoints.add(endpoint)
          return true
        })
      } else {
        const legacy = await this.platform.credentials.read(LEGACY_STORAGE_KEY)
        if (legacy) {
          const saved = SavedDevice.parse(JSON.parse(legacy))
          this.records = [{ ...saved, id: crypto.randomUUID(), name: '我的电脑', deviceName: '手机浏览器', lastConnectedAt: null }]
          migrated = true
        }
      }
      const selected = this.records.find((host) => host.id === preferred) ?? this.records[0]
      if (this.forgetInitialHost && selected) this.records = this.records.filter((host) => host.id !== selected.id)
      if (this.forgetInitialHost && !this.invitation) this.select(this.records[0]?.id ?? null)
      else if (revision === this.selectionRevision && !this.invitation) this.selectedHostId = selected?.id ?? null
    } catch { this.storageNotice = '无法读取已保存的电脑，请重新配对；原有凭据未被修改' }
    this.initialized = true
    if (migrated || this.forgetInitialHost) {
      const saved = await this.persist()
      if (saved) {
        try { await this.platform.credentials.write(LEGACY_STORAGE_KEY, null) } catch {}
      }
    }
  }

  private persist(): Promise<boolean> {
    const snapshot = JSON.stringify({ version: 3, hosts: this.records })
    this.saving = this.saving.then(async () => {
      try {
        const durable = await this.platform.credentials.write(STORAGE_KEY, snapshot)
        this.storageNotice = durable ? '' : STORAGE_NOTICE
        return durable
      } catch { this.storageNotice = STORAGE_NOTICE; return false }
    })
    return this.saving
  }

  async flushCredentials(): Promise<boolean> {
    await this.ready
    return this.saving
  }

  private select(id: string | null): void {
    this.selectedHostId = id
    try { this.platform.preferences.write(ACTIVE_HOST_KEY, id) } catch {}
  }

  selectHost(id: string): void {
    if (!this.records.some((host) => host.id === id)) throw new Error('此电脑已被移除，请重新配对')
    this.selectionRevision++
    this.invitation = null
    this.invitationProblem = ''
    this.select(id)
    this.disconnect('已切换电脑，请连接')
  }

  async renameHost(id: string, name: string): Promise<void> {
    await this.ready
    const label = name.trim()
    if (!label || label.length > 80) throw new Error('电脑名称需为 1 至 80 个字符')
    if (!this.records.some((host) => host.id === id)) throw new Error('此电脑已被移除')
    this.records = this.records.map((host) => host.id === id ? { ...host, name: label } : host)
    await this.persist()
  }

  importInvitation(link: string): void {
    let invitation: RemotePairingPayload
    try { invitation = parseInvitation(link) }
    catch { throw new Error(INVALID_INVITATION) }
    if (invitation.expiresAt <= Date.now()) throw new Error('二维码已过期，请在电脑上重新生成')
    const known = this.records.find((host) => invitation.nodeId && host.nodeId === invitation.nodeId)
    if (known && known.address !== invitation.address) throw new Error('节点连接身份已变化，请移除旧记录后重新配对')
    if (this.redeemedTickets.has(invitation.ticket)) throw new Error('二维码已用于配对，请连接已保存的电脑')
    this.selectionRevision++
    this.invitation = invitation
    this.invitationProblem = ''
    this.selectedHostId = null
    this.disconnect('配对链接已导入，请连接电脑')
  }

  disconnect(message = '已断开，可重新连接'): void {
    this.generation++
    const cancel = this.cancelConnect
    this.cancelConnect = null
    cancel?.()
    clearInterval(this.heartbeat)
    this.connection?.close()
    this.connection = null
    this.connected = false
    this.methods = new Set(LEGACY_METHODS)
    this.desktop?.close()
    this.desktop = null
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new NodeRequestError(item.write && item.sent ? WRITE_UNKNOWN : message, null, item.write && item.sent)) }
    this.pending.clear()
    this.queue = Promise.resolve()
    this.changed(message)
  }

  forget(): void {
    this.selectionRevision++
    if (!this.initialized && !this.invitation) this.forgetInitialHost = true
    this.records = this.records.filter((host) => host.id !== this.selectedHostId)
    this.invitation = null
    this.invitationProblem = ''
    this.select(this.records[0]?.id ?? null)
    if (this.initialized) void this.persist()
    this.disconnect('已移除此电脑')
  }

  async connect(deviceName: string, hostName?: string): Promise<void> {
    this.disconnect('正在加载网络组件…')
    const generation = this.generation
    const cancelled = new Promise<never>((_, reject) => { this.cancelConnect = () => reject(new Error('连接已取消')) })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.ready, cancelled])
      if (generation !== this.generation) throw new Error('连接已取消')
      const invitation = this.invitation
      const saved = this.saved
      const info = invitation ?? saved
      if (!info) throw new Error(this.invitationProblem || '请扫描电脑设置里的配对二维码')
      const known = this.records.find((host) => invitation?.nodeId && host.nodeId === invitation.nodeId)
      if (known && known.address !== info.address) throw new Error('节点连接身份已变化，请移除旧记录后重新配对')
      if (invitation && invitation.expiresAt <= Date.now()) throw new Error('二维码已过期，请在电脑上重新生成')
      await Promise.race([this.platform.prepareNetwork(), cancelled])
      if (generation !== this.generation) throw new Error('连接已取消')
      if (invitation && invitation.expiresAt <= Date.now()) throw new Error('二维码已过期，请在电脑上重新生成')
      this.changed('正在连接电脑…')
      const dial = this.platform.dial({ addr: info.address, port: info.port })
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('连接超时，请确认电脑在线后重试')), 45000) })
      void dial.then((connection) => { if (generation !== this.generation) connection.close() }, () => {})
      const connection = await Promise.race([dial, timeout, cancelled])
      clearTimeout(timer)
      if (generation !== this.generation) { connection.close(); throw new Error('连接已取消') }
      this.connection = connection
      void this.read(connection, generation)
      if (invitation) {
        const phone = deviceName.trim().slice(0, 80) || this.platform.deviceName || '浏览器'
        const frame = await this.request({ kind: 'pair', ticket: invitation.ticket, deviceName: phone })
        if (generation !== this.generation) throw new Error('连接已取消')
        if (frame.kind !== 'paired') throw new Error('配对响应无效')
        if (invitation.nodeId && frame.nodeId !== invitation.nodeId) throw new Error('节点身份与二维码不一致，请重新配对')
        const nodeId = frame.nodeId
        const pinned = this.records.find((host) => nodeId && host.nodeId === nodeId)
        if (pinned && pinned.address !== info.address) throw new Error('节点连接身份已变化，请移除旧记录后重新配对')
        const previous = this.records.find((host) => (nodeId && host.nodeId === nodeId) || (!host.nodeId && host.address === info.address && host.port === info.port))
        for (const [ticket, expiresAt] of this.redeemedTickets) if (expiresAt <= Date.now()) this.redeemedTickets.delete(ticket)
        this.redeemedTickets.set(invitation.ticket, invitation.expiresAt)
        const host: SavedHost = {
          address: info.address, port: info.port, deviceId: frame.deviceId, deviceToken: frame.deviceToken, ...(nodeId ? { nodeId } : {}),
          id: previous?.id ?? crypto.randomUUID(), name: hostName?.trim().slice(0, 80) || previous?.name || frame.nodeName || invitation.nodeName || (this.records.length ? `电脑 ${this.records.length + 1}` : '我的电脑'),
          deviceName: phone, lastConnectedAt: Date.now()
        }
        this.records = [...this.records.filter((entry) => entry.id !== host.id), host]
        this.select(host.id)
        this.invitation = null
        await Promise.race([this.persist(), cancelled])
      } else if (saved) {
        const frame = await this.request({ kind: 'resume', deviceId: saved.deviceId, deviceToken: saved.deviceToken })
        if (generation !== this.generation) throw new Error('连接已取消')
        if (frame.kind !== 'resumed' || frame.deviceId !== saved.deviceId) throw new Error('重连响应无效')
        if (saved.nodeId && frame.nodeId !== saved.nodeId) throw new Error('节点身份已变化，请重新配对')
        this.records = this.records.map((host) => host.id === saved.id ? { ...host, lastConnectedAt: Date.now() } : host)
        await Promise.race([this.persist(), cancelled])
      }
      if (generation !== this.generation) throw new Error('连接已取消')
      this.connected = true
      this.heartbeat = setInterval(() => { void this.request({ kind: 'ping' }).catch(() => { if (generation === this.generation) this.disconnect('连接中断，请重新连接') }) }, 20000)
      this.changed('已连接')
    } catch (error) { if (generation === this.generation) this.disconnect(); throw error }
    finally { clearTimeout(timer); if (generation === this.generation) this.cancelConnect = null }
  }
  async call<M extends RemoteMethod>(method: M, params: RemoteParams<M>, requestId: string = crypto.randomUUID()): Promise<RemoteResult<M>> {
    if (!this.connected) throw new Error('请先连接电脑')
    if (!this.supports(method)) throw new NodeRequestError('当前节点尚不支持此功能，请更新节点后重连', 'unsupported-operation')
    const generation = this.generation
    const write = REMOTE_WRITE_METHODS.includes(method)
    const frame = await this.request({ kind: 'operation', operation: { method, params }, ...(write ? { requestId } : {}) }, write)
    if (frame.kind !== 'operation') throw new NodeRequestError(write ? WRITE_UNKNOWN : '电脑返回了无效响应', null, write)
    const result = remoteOperationSchemas[method].result.safeParse(frame.result)
    if (!result.success) throw new NodeRequestError(write ? WRITE_UNKNOWN : '电脑返回了无效响应', null, write)
    if (method === 'catalog' && generation === this.generation) {
      const catalog = remoteOperationSchemas.catalog.result.safeParse(frame.result)
      if (catalog.success) this.methods = new Set(catalog.data.methods ?? LEGACY_METHODS)
    }
    return result.data
  }
  async openDesktop(): Promise<NodeRpcTransport> {
    if (!this.connected) throw new NodeRequestError('请先连接电脑', 'connection-closed')
    if (this.desktop) throw new NodeRequestError('桌面连接已经打开', 'desktop-already-open')
    const generation = this.generation
    const connection = this.connection
    const listeners = new Set<(frame: RpcFrame) => void>()
    let resolveClosed: () => void = () => {}
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
    const session: DesktopSession = {
      receive(frame) { for (const listener of listeners) listener(frame) },
      close() { listeners.clear(); resolveClosed() }
    }
    this.desktop = session
    try {
      const frame = await this.request({ kind: 'desktop' })
      if (generation !== this.generation || this.desktop !== session) throw new NodeRequestError('连接已关闭', 'connection-closed')
      if (frame.kind !== 'desktop') throw new NodeRequestError('当前节点不支持完整桌面工作区，请更新节点或使用手机版界面', 'desktop-unavailable')
      return {
        protocolVersion: frame.protocolVersion, methods: frame.methods, closed,
        onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        close: () => { if (generation === this.generation && this.desktop === session) this.disconnect() },
        send: (request) => {
          const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'rpc', request, requestId: crypto.randomUUID() }) + '\n')
          if (bytes.length > 64 * 1024) return Promise.reject(new NodeRequestError('消息超过远程通道的 64 KiB 上限，请缩短内容', 'request-too-large'))
          const send = this.queue.catch(() => {}).then(() => {
            if (!connection || !this.connected || generation !== this.generation || this.desktop !== session) throw new NodeRequestError('连接已关闭', 'connection-closed')
            return connection.write(bytes)
          })
          this.queue = send.catch(() => {
            if (generation === this.generation && this.desktop === session) this.disconnect('发送失败，请重新连接')
          })
          return send
        }
      }
    } catch (error) {
      if (this.desktop === session) this.desktop = null
      session.close()
      throw error
    }
  }
  private request(fields: object, write = false): Promise<RemoteWireResponse> {
    const connection = this.connection
    if (!connection) return Promise.reject(new Error('尚未连接'))
    const generation = this.generation
    const id = String(++this.nextId)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id)
        if (!item) return
        this.pending.delete(id)
        reject(new NodeRequestError(item.write ? item.sent ? WRITE_UNKNOWN : '操作尚未发送，请重新连接后重试' : '请求超时，请重试', null, item.write && item.sent))
      }, write ? 120000 : 30000)
      this.pending.set(id, { resolve, reject, timer, write, sent: false })
      this.queue = this.queue.catch(() => {}).then(() => {
        const item = this.pending.get(id)
        if (generation !== this.generation || connection !== this.connection || !item) return
        const bytes = new TextEncoder().encode(JSON.stringify({ ...fields, id }) + '\n')
        item.sent = true
        return connection.write(bytes)
      })
      void this.queue.catch(() => {
        if (generation === this.generation && connection === this.connection) this.disconnect('发送失败，请重新连接')
      })
    })
  }
  private async read(connection: NodeTunnel, generation: number): Promise<void> {
    let text = ''
    const decoder = new TextDecoder()
    try {
      while (generation === this.generation) {
        const bytes = await connection.read()
        if (generation !== this.generation) return
        if (bytes === null) break
        text += decoder.decode(bytes, { stream: true })
        let newline: number
        while ((newline = text.indexOf('\n')) >= 0) {
          if (generation !== this.generation) return
          if (newline > 4 * 1024 * 1024) throw new Error('响应过大，请在电脑上查看')
          const frame = RemoteWireResponse.parse(JSON.parse(text.slice(0, newline)))
          text = text.slice(newline + 1)
          if (frame.kind === 'rpc') { this.desktop?.receive(frame.frame); continue }
          if (!frame.id) {
            if (frame.kind === 'error') { this.disconnect(frame.message); return }
            continue
          }
          const item = this.pending.get(frame.id)
          if (!item) continue
          clearTimeout(item.timer)
          this.pending.delete(frame.id)
          if (frame.kind === 'error') {
            const unknown = item.write && ['operation-timeout', 'operation-cancelled', 'operation-failed', 'already-completed', 'result-too-large'].includes(frame.code)
            item.reject(new NodeRequestError(frame.code === 'unauthorized' || frame.code === 'invalid-invitation' ? '授权已失效，请在电脑上重新扫码配对' : `${frame.message} (${frame.code})`, frame.code, unknown))
          }
          else item.resolve(frame)
        }
        if (text.length > 4 * 1024 * 1024) throw new Error('响应过大，请在电脑上查看')
      }
      if (generation === this.generation) this.disconnect('电脑连接已关闭，请重新连接')
    } catch (error) {
      if (generation === this.generation) this.disconnect(error instanceof Error ? error.message : '连接中断')
    }
  }
}
