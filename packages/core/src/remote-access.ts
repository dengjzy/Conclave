import { mkdir, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import type { RemoteAccessStatus, RemoteInvitation } from '@conclave/protocol'
import { createRemoteGateway, type RemoteCall, type RemoteGateway } from './remote-gateway'
import { prepareTailcatRuntime, remoteRuntimeSupported, startRemoteNetwork } from './remote-runtime'
import type { RemoteRpcSession } from './remote-rpc'
import type { RpcFrame } from '@conclave/protocol'
import { Rejection } from './rejection'
import { RemoteState } from './remote-state'

type Network = Awaited<ReturnType<typeof startRemoteNetwork>>
type Run = {
  controller: AbortController
  gateway: RemoteGateway | null
  network: Network | null
  startup: Promise<void> | null
  cleanup: Promise<void> | null
  closing: boolean
  failed: boolean
  publishWeb: boolean
}

export class RemoteAccessService {
  private state: RemoteAccessStatus['state'] = 'disabled'
  private problem: string | null = null
  private run: Run | null = null
  private stopping: Promise<RemoteAccessStatus> | null = null
  private closed = false
  private store: RemoteState | null = null
  private readonly loaded: Promise<RemoteState>

  constructor(private readonly options: {
    home: string
    call: RemoteCall
    openDesktop?: (send: (frame: RpcFrame) => void) => RemoteRpcSession
    changed: (status: RemoteAccessStatus) => void
  }) {
    this.loaded = RemoteState.open(path.join(options.home, 'remote', 'identity'))
    void this.loaded.then((store) => { this.store = store; if (!this.closed) this.emit() }, () => {})
  }

  status(): RemoteAccessStatus {
    return {
      supported: remoteRuntimeSupported(), state: this.state, problem: this.problem, access: 'control',
      clientUrl: this.state === 'ready' ? this.run?.network?.clientUrl ?? null : null,
      devices: this.run?.gateway?.listDevices() ?? this.store?.devices.map((device) => ({ id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, online: false })) ?? [],
      ...this.store?.identity,
      webState: this.state === 'ready' ? this.run?.network?.webState ?? 'disabled' : 'disabled',
      webProblem: this.state === 'ready' ? this.run?.network?.webProblem ?? null : null
    }
  }

  start(options: { web?: boolean } = {}): RemoteAccessStatus {
    if (this.closed) throw new Rejection('remote-closed', '远程访问服务已关闭')
    if (!remoteRuntimeSupported()) throw new Rejection('remote-unsupported', '这台电脑暂不支持远程访问实验')
    if (this.run || this.stopping) return this.status()
    const run: Run = { controller: new AbortController(), gateway: null, network: null, startup: null, cleanup: null, closing: false, failed: false, publishWeb: options.web ?? true }
    this.run = run
    this.state = 'preparing'
    this.problem = null
    this.emit()
    run.startup = this.launch(run)
    return this.status()
  }

  stop(): Promise<RemoteAccessStatus> {
    if (this.stopping) return this.stopping
    const run = this.run
    if (run) { run.closing = true; run.controller.abort() }
    this.stopping = (async () => {
      if (run) { await run.startup; await this.dispose(run) }
      if (this.run === run) this.run = null
      this.state = 'disabled'
      this.problem = null
      this.emit()
      return this.status()
    })().finally(() => { this.stopping = null })
    return this.stopping
  }

  createInvitation(): RemoteInvitation {
    const run = this.run
    if (this.state !== 'ready' || !run?.gateway || !run.network || run.closing || run.controller.signal.aborted) throw new Rejection('remote-not-ready', '远程访问尚未就绪')
    let invitation
    try { invitation = run.gateway.createInvitation() } catch { throw new Rejection('remote-invitation-limit', '请等待已有二维码过期后再生成') }
    const payload = { version: 2, address: run.network.address, port: run.gateway.address.port, ticket: invitation.ticket, expiresAt: invitation.expiresAt }
    const appUrl = `https://agents-go.invalid/#pair=${encodeURIComponent(JSON.stringify({ ...payload, ...this.store?.identity }))}`
    const url = run.network.clientUrl ? `${run.network.clientUrl}#pair=${encodeURIComponent(JSON.stringify(payload))}` : appUrl
    return { url, appUrl, expiresAt: invitation.expiresAt }
  }

  async revokeDevice(deviceId: string): Promise<RemoteAccessStatus> {
    const store = await this.loaded
    await this.run?.startup
    if (this.run?.gateway) this.run.gateway.revoke(deviceId)
    else {
      try { store.save(store.port, store.devices.filter((device) => device.id !== deviceId)) }
      catch { throw new Rejection('remote-storage-failed', '无法保存设备撤销记录，请在电脑端检查存储后重试。') }
      this.emit()
    }
    return this.status()
  }

  startWeb(): RemoteAccessStatus {
    if (this.state !== 'ready' || !this.run?.network || this.run.closing) throw new Rejection('remote-not-ready', '远程访问尚未就绪')
    this.run.network.startWeb()
    return this.status()
  }

  async stopWeb(): Promise<RemoteAccessStatus> {
    await this.run?.network?.stopWeb()
    return this.status()
  }

  async close(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  private emit(): void { this.options.changed(this.status()) }

  private async launch(run: Run): Promise<void> {
    let failureMessage = '远程访问组件准备失败，请检查网络或磁盘空间后重试。'
    try {
      const store = await this.loaded
      const remoteHome = path.join(this.options.home, 'remote')
      await mkdir(remoteHome, { recursive: true, mode: 0o700 })
      run.controller.signal.throwIfAborted()
      const assetsDirectory = process.env.CONCLAVE_REMOTE_ASSETS ? path.resolve(process.env.CONCLAVE_REMOTE_ASSETS) : path.join(remoteHome, 'runtime')
      await prepareTailcatRuntime({ directory: assetsDirectory, signal: run.controller.signal })
      run.controller.signal.throwIfAborted()
      failureMessage = '本机远程通道启动失败，请重试。'
      this.state = 'starting'
      this.emit()
      const stateDirectory = await mkdtemp(path.join(remoteHome, 'session-'))
      run.controller.signal.throwIfAborted()
      run.gateway = await createRemoteGateway({ call: this.options.call, openDesktop: this.options.openDesktop, state: store, changed: () => { if (this.run === run && !run.closing) this.emit() } })
      run.controller.signal.throwIfAborted()
      failureMessage = '远程网络连接未能建立，请检查网络后重试。'
      run.network = await startRemoteNetwork({
        assetsDirectory, stateDirectory, identityDirectory: path.join(remoteHome, 'identity'), gatewayPort: run.gateway.address.port,
        requireExistingKey: store.devices.length > 0, publishWeb: run.publishWeb, signal: run.controller.signal,
        onExit: () => this.networkExited(run),
        onWebChanged: () => { if (this.run === run && !run.closing) this.emit() }
      })
      run.controller.signal.throwIfAborted()
      this.state = 'ready'
      this.emit()
    } catch {
      const report = run.failed || !run.controller.signal.aborted
      await this.dispose(run)
      if (this.run === run) {
        this.run = null
        if (report) {
          this.state = 'error'
          this.problem = failureMessage
          this.emit()
        }
      }
    }
  }

  private networkExited(run: Run): void {
    if (run.closing || this.run !== run) return
    run.failed = true
    run.controller.abort()
    // Startup owns partial resources until it settles; a ready run can be cleaned immediately.
    if (this.state !== 'ready') return
    void this.dispose(run).then(() => {
      if (this.run !== run) return
      this.run = null
      this.state = 'error'
      this.problem = '远程连接组件已退出，请重新开启远程访问。'
      this.emit()
    })
  }

  private dispose(run: Run): Promise<void> {
    if (run.cleanup) return run.cleanup
    run.closing = true
    run.controller.abort()
    const gateway = run.gateway
    const network = run.network
    run.gateway = null
    run.network = null
    run.cleanup = Promise.allSettled([gateway?.close(), network?.close()]).then(() => {})
    return run.cleanup
  }
}
