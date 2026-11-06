import { z, ZodError } from 'zod'
import {
  LEGACY_USAGE_WINDOW_KINDS, REMOTE_DESKTOP_FEATURES, REMOTE_DESKTOP_NOTIFICATIONS,
  RPC_ERROR, RemoteOperation, REMOTE_DESKTOP_WRITE_METHODS, isRemoteDesktopMethod, rpcSchemas,
  type RpcFrame, type RpcMethod, type RpcRequest
} from '@conclave/protocol'
import { Rejection } from './rejection'
import type { RemoteCall } from './remote-gateway'
import type { Connection } from './rpc-server'

export type RemoteRpcSession = {
  request(request: RpcRequest, signal: AbortSignal, requestId?: string): Promise<RpcFrame>
  close(): void
}

export function openRemoteRpcSession(options: {
  dispatch(method: RpcMethod, params: unknown, connection: Connection): unknown | Promise<unknown>
  call: RemoteCall
  connections: Set<Connection>
  send(frame: RpcFrame): void
  closed(): void
}): RemoteRpcSession {
  let closed = false
  const listeners = new Set<() => void>()
  const connection: Connection = {
    attached: new Set(), watching: new Set(), browsing: new Set(), wiring: new Set(),
    usageKinds: new Set(LEGACY_USAGE_WINDOW_KINDS),
    notify(name, params) {
      if (!closed && REMOTE_DESKTOP_NOTIFICATIONS.some((allowed) => allowed === name)) options.send({ jsonrpc: '2.0', method: name, params })
    },
    onClose(listener) {
      if (closed) listener()
      else listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  options.connections.add(connection)
  function dispatch<M extends RpcMethod>(method: M, params: unknown) {
    return options.dispatch(method, rpcSchemas[method].params.parse(params ?? {}), connection)
  }
  const rejected = (id: number, reason: string, message: string): RpcFrame => ({ jsonrpc: '2.0', id, error: { code: RPC_ERROR.rejected, message, data: { reason } } })
  return {
    async request(request, signal, requestId) {
      const { id, method, params } = request
      if (closed) return rejected(id, 'remote-session-closed', '节点连接已断开，请重新连接。')
      if (!isRemoteDesktopMethod(method)) return rejected(id, 'remote-method-denied', '此操作需要在节点主机上完成。')
      try {
        signal.throwIfAborted()
        let result: unknown
        if (REMOTE_DESKTOP_WRITE_METHODS.some((write) => write === method)) {
          const operation = desktopWrite(request, requestId)
          result = await options.call(operation.method, operation.params, signal)
        } else result = await dispatch(method, params)
        if (method === 'system.hello') {
          const hello = rpcSchemas['system.hello'].result.parse(result)
          result = { ...hello, features: hello.features?.filter((feature) => REMOTE_DESKTOP_FEATURES.some((allowed) => allowed === feature)) }
        }
        return { jsonrpc: '2.0', id, result }
      } catch (error) {
        if (error instanceof ZodError) return { jsonrpc: '2.0', id, error: { code: RPC_ERROR.invalidParams, message: '操作参数无效。', data: { reason: 'invalid-params' } } }
        if (error instanceof Rejection) return rejected(id, error.reason, error.message)
        return { jsonrpc: '2.0', id, error: { code: RPC_ERROR.internal, message: '操作未能完成，请在节点主机上检查。', data: { reason: 'operation-failed' } } }
      }
    },
    close() {
      if (closed) return
      closed = true
      options.connections.delete(connection)
      for (const listener of listeners) {
        try { listener() } catch (error) { console.error('[conclave-core] remote connection cleanup failed', error) }
      }
      listeners.clear()
      connection.attached.clear()
      connection.watching.clear()
      connection.browsing.clear()
      connection.wiring.clear()
      options.closed()
    }
  }
}

function desktopWrite(request: RpcRequest, requestId?: string): RemoteOperation {
  const params = z.record(z.string(), z.unknown()).parse(request.params ?? {})
  const unsupported = () => { throw new Rejection('remote-parameter-denied', '此参数需要在节点主机上使用；远程工作区沿用手机端的控制权限。') }
  const removeDefault = (key: string, value: unknown) => {
    if (params[key] !== undefined && params[key] !== value) unsupported()
    delete params[key]
  }
  if ('allowBypass' in params) removeDefault('allowBypass', false)
  if (request.method === 'conversations.create') {
    // The original UI's deferred start separates creation from the first message, as mobile does.
    if (params.deferStart !== true) unsupported()
    removeDefault('deferStart', true)
    if ('worktree' in params) removeDefault('worktree', false)
  }
  if (request.method === 'tasks.start' && 'permissionMode' in params) removeDefault('permissionMode', 'ask')
  if (request.method === 'tasks.create' || request.method === 'conversations.send') {
    for (const key of ['images', 'references', 'dependsOn']) {
      const value = params[key]
      if (value === undefined || (Array.isArray(value) && value.length === 0)) delete params[key]
    }
  }
  if (request.method === 'conversations.send') {
    if ('queue' in params) removeDefault('queue', true)
    if ('steer' in params) removeDefault('steer', false)
  }
  if ((request.method === 'conversations.send' || request.method === 'agentCalls.dispatch') && params.ref === undefined) params.ref = requestId
  const operation = RemoteOperation.safeParse({ method: request.method, params })
  if (!operation.success) throw new Rejection('remote-parameter-denied', '此参数需要在节点主机上使用；远程工作区沿用手机端的控制权限。')
  return operation.data
}
