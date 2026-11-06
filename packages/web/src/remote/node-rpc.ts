import { z } from 'zod'
import { createRpcClient, PROTOCOL_VERSION, REMOTE_DESKTOP_WRITE_METHODS, RpcError, RpcRequest, type RpcConnection, type RpcMethod } from '@conclave/protocol'
import { NodeConnection, NodeRequestError } from './node-connection'

const desktopMethods = new WeakMap<RpcConnection, readonly string[]>()

export function nodeRpcSupports(rpc: RpcConnection, method: RpcMethod): boolean {
  const methods = desktopMethods.get(rpc)
  return !methods || methods.includes(method)
}

export function nodeRpcMethods(rpc: RpcConnection): readonly string[] | null {
  return desktopMethods.get(rpc) ?? null
}

const REQUEST_TIMEOUT_MS = 120_000
const UNKNOWN_OUTCOME = '操作结果未知，请重新连接并刷新状态确认，勿重复提交'
const UNKNOWN_REASONS = new Set(['connection-closed', 'request-timeout', 'operation-timeout', 'operation-cancelled', 'operation-failed', 'already-completed', 'result-too-large'])

export async function connectDesktopRpc(node: NodeConnection): Promise<RpcConnection> {
  const revision = node.connectionRevision
  const catalog = await node.call('catalog', {}).catch((error: unknown) => {
    if (revision !== node.connectionRevision || !node.connected) throw new NodeRequestError('连接已关闭，请重新连接', 'connection-closed')
    throw error
  })
  if (revision !== node.connectionRevision || !node.connected) throw new NodeRequestError('连接已关闭，请重新连接', 'connection-closed')
  if (!catalog.capabilities?.includes('desktop-workspace')) {
    throw new NodeRequestError('当前节点不支持完整桌面工作区，请更新节点或使用手机版界面', 'desktop-unavailable')
  }
  const transport = await node.openDesktop()
  if (transport.protocolVersion !== PROTOCOL_VERSION) {
    transport.close()
    throw new NodeRequestError('客户端与节点版本不一致，请更新后重新连接', 'protocol-mismatch')
  }
  const methods = new Set(transport.methods)
  let closed = false
  let active = 0
  let nextSendAt = 0
  let queueTimer: ReturnType<typeof setTimeout> | undefined
  const waiting: Array<{ start(): void; reject(error: Error): void }> = []
  const client = createRpcClient((text) => {
    const request = RpcRequest.parse(JSON.parse(text))
    void transport.send(request).catch((error: unknown) => {
      client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
        code: -32000,
        message: error instanceof Error ? error.message : '发送失败，请重新连接',
        data: { reason: error instanceof NodeRequestError ? error.code ?? 'connection-closed' : 'connection-closed' }
      } }))
    })
  })
  const stop = transport.onFrame((frame) => client.receive(JSON.stringify(frame)))
  function shutdown(error: Error): void {
    if (closed) return
    closed = true
    clearTimeout(queueTimer)
    stop()
    for (const queued of waiting.splice(0)) queued.reject(new NodeRequestError('连接已关闭，此操作尚未发送', 'request-not-sent'))
    client.failAll(error)
  }
  function drain(): void {
    clearTimeout(queueTimer)
    queueTimer = undefined
    if (!node.connected || node.connectionRevision !== revision) shutdown(new NodeRequestError('连接已关闭，请重新连接', 'connection-closed'))
    if (closed || active >= 3 || !waiting.length) return
    const delay = Math.max(0, nextSendAt - Date.now())
    if (delay) { queueTimer = setTimeout(drain, delay); return }
    const next = waiting.shift()
    if (!next) return
    active++
    nextSendAt = Date.now() + 50
    next.start()
    drain()
  }
  void transport.closed.then(() => shutdown(new NodeRequestError('连接已关闭，请重新连接', 'connection-closed')))
  const connection: RpcConnection = {
    ...client,
    closed: transport.closed,
    close: () => { shutdown(new NodeRequestError('连接已关闭，请重新连接', 'connection-closed')); transport.close() },
    features: [],
    async call(method, params) {
      if (closed) throw new NodeRequestError('连接已关闭，请重新连接', 'connection-closed')
      if (!methods.has(method)) throw new RpcError('此节点未开放这项远程功能', -32601, 'remote-method-denied')
      return new Promise((resolve, reject) => {
        waiting.push({ reject, start() {
          const timer = setTimeout(() => {
            shutdown(new NodeRequestError('请求超时，请重新连接', 'request-timeout'))
            transport.close()
          }, REQUEST_TIMEOUT_MS)
          void client.call(method, params).then(resolve, (error: unknown) => {
            const reason = error instanceof RpcError ? error.reason : error instanceof NodeRequestError ? error.code : null
            if (REMOTE_DESKTOP_WRITE_METHODS.some((allowed) => allowed === method) && ((reason && UNKNOWN_REASONS.has(reason)) || error instanceof z.ZodError)) {
              reject(new NodeRequestError(UNKNOWN_OUTCOME, reason ?? 'invalid-response', true))
            } else reject(error)
          }).finally(() => {
            clearTimeout(timer)
            active--
            drain()
          })
        } })
        drain()
      })
    }
  }
  try {
    const hello = await connection.call('system.hello', { protocolVersion: PROTOCOL_VERSION })
    if (hello.protocolVersion !== PROTOCOL_VERSION) throw new NodeRequestError('客户端与节点版本不一致，请更新后重新连接', 'protocol-mismatch')
    const negotiated = { ...connection, features: hello.features ?? [] }
    desktopMethods.set(negotiated, [...methods])
    return negotiated
  } catch (error) {
    transport.close()
    throw error
  }
}
