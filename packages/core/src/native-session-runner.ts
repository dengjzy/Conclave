import { z } from 'zod'
import { createLineDecoder, type DaemonEvent } from '@conclave/protocol/node'
import type { AgentKind, ChatCatalog } from '@conclave/protocol'
import type { ChatDriver } from './chat-driver'
import { catalogOf } from './chat-catalog'
import type { AgentCommand } from './agent-command'
import type { SessionHost } from './daemon-client'
import type { NativeSessionExecutor, NativeSession } from './native-session'
import { Rejection } from './rejection'

const Frame = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional()
})
const Initialized = z.looseObject({ agentCapabilities: z.looseObject({ sessionCapabilities: z.record(z.string(), z.unknown()).optional() }).optional() })
const MAX_OUTPUT = 4 * 1024 * 1024

export class NativeSessionRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'NativeSessionRpcError' }
}

export class NativeSessionRunner implements NativeSessionExecutor {
  constructor(private readonly daemon: SessionHost, private readonly timeoutMs = 30_000, private readonly stopGraceMs = 2_000, private readonly cleanupSession?: (agent: AgentKind, session: NativeSession) => Promise<void>, private readonly registerSession?: (agent: AgentKind, session: NativeSession, daemonSessionId: string) => Promise<void>) {}

  async catalog(driver: ChatDriver, command: AgentCommand, cwd: string, onSession?: (id: string, daemonSessionId: string) => Promise<void>): Promise<ChatCatalog | null> {
    if (!this.cleanupSession || !this.registerSession) return null
    const result = await this.run(command, cwd, null, driver, onSession)
    const parsed = z.object({ models: z.array(z.unknown()) }).safeParse(result)
    return parsed.success ? catalogOf(driver.items.list()) : null
  }

  register(agent: AgentKind, session: NativeSession, daemonSessionId: string): Promise<void> {
    if (!this.registerSession) return Promise.reject(new Rejection('native-session-cleanup-unavailable', '原生会话归属登记未就绪'))
    return this.registerSession(agent, session, daemonSessionId)
  }

  cleanup(agent: AgentKind, session: NativeSession): Promise<void> {
    if (!this.cleanupSession) return Promise.reject(new Rejection('native-session-cleanup-unavailable', '原生会话清理服务未就绪'))
    return this.cleanupSession(agent, session)
  }

  command(command: AgentCommand, cwd: string): Promise<string> {
    return this.run(command, cwd, null).then((result) => typeof result === 'string' ? result : '')
  }

  acp(command: AgentCommand, cwd: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.run(command, cwd, { method, params })
  }

  private async run(command: AgentCommand, cwd: string, rpc: { method: string; params: Record<string, unknown> } | null, driver?: ChatDriver, onSession?: (id: string, daemonSessionId: string) => Promise<void>): Promise<unknown> {
    const { sessionId } = await this.daemon.request('spawnPipe', { command: command.command, args: command.args, cwd, env: command.env ?? {} })
    let output = '', stderr = '', offset = 0, attached = false, exited = false, settled = false
    let persisting = false, registered: string | null = null
    let ready = false, resolveExit: (() => void) | undefined
    const exit = new Promise<void>((resolve) => { resolveExit = resolve })
    const queued: DaemonEvent[] = []
    let succeed: (result: unknown) => void = () => {}, fail: (error: Error) => void = () => {}
    const result = new Promise<unknown>((resolve, reject) => {
      succeed = (value) => { if (!settled) { settled = true; resolve(value) } }
      fail = (error) => { if (!settled) { settled = true; reject(error) } }
    })
    // Attach can itself fail before the result is awaited.
    void result.catch(() => {})
    const pending = new Set<string>()
    const pump = () => {
      if (!driver || settled || persisting) return
      for (const frame of driver.due()) {
        const request = Frame.safeParse(frame).data
        if (request?.method && ['thread/start', 'thread/resume', 'skills/list'].includes(request.method)) continue
        driver.apply({ dir: 'out', at: Date.now(), frame })
        if (request?.method && request.id !== undefined) pending.add(String(request.id))
        void this.daemon.request('write', { sessionId, data: `${JSON.stringify(frame)}\n` }).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
      }
      const catalog = catalogOf(driver.items.list())
      if (catalog && pending.size === 0) succeed(catalog)
    }
    const send = (id: string, method: string, params: unknown) => {
      void this.daemon.request('write', { sessionId, data: `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n` }).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
    }
    const decode = createLineDecoder((line) => {
      if (settled) return
      let json: unknown
      try { json = JSON.parse(line) } catch { return }
      const frame = Frame.safeParse(json).data
      if (!frame) return
      if (driver) {
        if (!frame.method && frame.id !== undefined) pending.delete(String(frame.id))
        driver.apply({ dir: 'in', at: Date.now(), frame: json })
        const id = driver.providerSessionId()
        if (id && id !== registered && onSession) {
          if (persisting) return
          persisting = true
          void onSession(id, sessionId).then(() => {
            registered = id; persisting = false; pump()
          }).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
        } else pump()
        return
      }
      if (!rpc) return
      if (frame.id === 'cleanup-init') {
        if (frame.error) { fail(new NativeSessionRpcError(frame.error.code, frame.error.message)); return }
        if (ready) return
        ready = true
        const capabilities = Initialized.safeParse(frame.result).data?.agentCapabilities?.sessionCapabilities
        if (rpc.method === 'session/delete' && !Object.hasOwn(capabilities ?? {}, 'delete')) {
          fail(new Rejection('native-session-delete-unsupported', '此 Agent 版本未提供原生会话删除能力'))
          return
        }
        send('cleanup-request', rpc.method, rpc.params)
      } else if (frame.id === 'cleanup-request') {
        if (frame.error) fail(new NativeSessionRpcError(frame.error.code, frame.error.message))
        else succeed(frame.result)
      } else if (frame.method && frame.id !== undefined) {
        void this.daemon.request('write', { sessionId, data: `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Cleanup does not provide client tools' } })}\n` }).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
      }
    })
    const receive = (event: DaemonEvent) => {
      if (event.sessionId !== sessionId) return
      if (!attached) { queued.push(event); return }
      if (event.event === 'data') {
        const data = event.data.slice(Math.max(0, offset - event.offset))
        offset = Math.max(offset, event.offset + event.data.length)
        output += data
        if (output.length > MAX_OUTPUT) { fail(new Rejection('native-session-output-limit', 'Agent 清理输出超出限制')); return }
        decode(data)
      } else if (event.event === 'stderr') stderr = (stderr + event.data).slice(-8192)
      else {
        exited = true; resolveExit?.()
        if (rpc || driver) fail(new Rejection('native-session-command-failed', stderr.trim() || `会话清理进程提前退出（${event.exitCode}）`))
        else if (event.exitCode === 0) succeed(output)
        else fail(new Rejection('native-session-command-failed', stderr.trim() || `会话清理命令失败（${event.exitCode}）`))
      }
    }
    const unsubscribe = this.daemon.onEvent(receive)
    const timer = setTimeout(() => fail(new Rejection('native-session-timeout', 'Agent 会话清理超时，请重试')), this.timeoutMs)
    try {
      const snapshot = await this.daemon.request('attach', { sessionId })
      attached = true
      stderr = snapshot.stderr ?? ''
      receive({ event: 'data', sessionId, data: snapshot.buffer, offset: snapshot.bufferStart })
      queued.splice(0).forEach(receive)
      if (snapshot.exited && !exited) receive({ event: 'exit', sessionId, exitCode: snapshot.exitCode ?? 1 })
      if (driver && !exited && !settled) pump()
      if (rpc && !exited && !settled) send('cleanup-init', 'initialize', { protocolVersion: 1, clientInfo: { name: 'conclave-cleanup', version: '1' }, clientCapabilities: {} })
      return await result
    } catch (error) {
      // Attaching can fail before the result promise is awaited.
      fail(error instanceof Error ? error : new Error(String(error)))
      return await result
    } finally {
      clearTimeout(timer)
      if (!exited) {
        await this.daemon.request('kill', { sessionId }).catch(() => {})
        let stopTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([exit, new Promise<void>((resolve) => { stopTimer = setTimeout(resolve, this.stopGraceMs) })])
        clearTimeout(stopTimer)
        if (!exited) {
          await this.daemon.request('kill', { sessionId, force: true }).catch(() => {})
          const snapshot = await this.daemon.request('attach', { sessionId }).catch(() => null)
          exited = snapshot?.exited ?? false
        }
      }
      unsubscribe()
      if (!exited) throw new Rejection('native-session-stop-failed', 'Agent 清理进程仍未停止，请稍后重试')
      if (exited) await this.daemon.request('release', { sessionId }).catch(() => {})
    }
  }
}
