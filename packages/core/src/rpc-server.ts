import { timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { ZodError } from 'zod'
import {
  LEGACY_USAGE_WINDOW_KINDS,
  RPC_ERROR,
  RpcRequest,
  isRpcMethod,
  rpcSchemas,
  type RpcMethod,
  type RpcNotificationName,
  type RpcNotificationParams,
  type RpcParsedParams,
  type RpcResult
} from '@conclave/protocol'
import { Rejection } from './rejection'

export type Connection = {
  readonly attached: Set<string>
  readonly watching: Set<string>
  readonly browsing: Set<string>
  readonly wiring: Set<string>
  readonly usageKinds: Set<string>
  notify<N extends RpcNotificationName>(name: N, params: RpcNotificationParams<N>): void
  onClose(listener: () => void): () => void
}

export type RpcHandlers = {
  [M in RpcMethod]: (
    params: RpcParsedParams<M>,
    connection: Connection
  ) => RpcResult<M> | Promise<RpcResult<M>>
}

export type RpcServer = {
  host: string
  port: number
  connections: ReadonlySet<Connection>
  broadcast<N extends RpcNotificationName>(name: N, params: RpcNotificationParams<N>): void
  close(): Promise<void>
}

function tokenMatches(url: string | undefined, token: string): boolean {
  const given = new URL(url ?? '/', 'ws://localhost').searchParams.get('token') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function errorFrame(id: number | null, code: number, message: string, reason?: string): string {
  const data = reason ? { reason } : undefined
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } })
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

const webDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')

export function getLanIp(): string | null {
  const interfaces = os.networkInterfaces()
  const virtualRegex = /^(docker|virbr|utun|veth|br-|vnet|tun|tap|zt)/i
  for (const name of Object.keys(interfaces)) {
    if (virtualRegex.test(name)) continue
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}

export function startRpcServer(options: {
  host?: string
  port: number
  token: string
  handlers: RpcHandlers
}): Promise<RpcServer> {
  const { handlers, token } = options
  const connections = new Set<Connection>()
  let serverPort = options.port

  function dispatch<M extends RpcMethod>(method: M, raw: unknown, connection: Connection) {
    return handlers[method](rpcSchemas[method].params.parse(raw ?? {}), connection)
  }

  async function handleFrame(text: string, connection: Connection): Promise<string> {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return errorFrame(null, RPC_ERROR.parseError, 'invalid JSON')
    }
    const request = RpcRequest.safeParse(json)
    if (!request.success) {
      return errorFrame(null, RPC_ERROR.invalidRequest, 'invalid request')
    }
    const { id, method, params } = request.data
    if (!isRpcMethod(method)) {
      return errorFrame(id, RPC_ERROR.methodNotFound, `unknown method ${method}`)
    }
    try {
      const result = await dispatch(method, params, connection)
      return JSON.stringify({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (error instanceof ZodError) {
        return errorFrame(id, RPC_ERROR.invalidParams, error.message, 'invalid-params')
      }
      if (error instanceof Rejection) {
        return errorFrame(id, RPC_ERROR.rejected, error.message, error.reason)
      }
      console.error(`[conclave-core] ${method} failed`, error)
      return errorFrame(id, RPC_ERROR.internal, 'internal error')
    }
  }

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = parsedUrl.pathname
    const isLoopback = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1'
    const cookieHeader = req.headers.cookie
    const hasValidCookie = Boolean(cookieHeader && cookieHeader.includes(`conclave_token=${token}`))
    const hasValidTokenInUrl = tokenMatches(req.url, token)

    if (pathname === '/api/auth/session') {
      const origin = req.headers.origin
      const host = req.headers.host
      let allowed = isLoopback || hasValidCookie || hasValidTokenInUrl
      if (origin && host) {
        try {
          const originUrl = new URL(origin)
          if ((originUrl.hostname === '127.0.0.1' || originUrl.hostname === 'localhost' || originUrl.host === host) && originUrl.host === host) {
            if (isLoopback || hasValidCookie || hasValidTokenInUrl) {
              allowed = true
            }
          }
        } catch {}
      }
      if (allowed) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `conclave_token=${token}; Path=/; SameSite=Lax`
        })
        res.end(JSON.stringify({ ok: true, version: '0.0.1', token }))
      } else {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
      }
      return
    }

    if (pathname === '/' || pathname === '/conclave' || pathname === '/conclave/') {
      if (hasValidTokenInUrl || isLoopback) {
        res.setHeader('Set-Cookie', `conclave_token=${token}; Path=/; SameSite=Lax`)
      }
    }

    let filePath = path.join(webDistDir, (pathname === '/' || pathname === '/conclave' || pathname === '/conclave/') ? 'index.html' : pathname.replace(/^\/+/, ''))
    if (!filePath.startsWith(webDistDir)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    try {
      let fileStat = await stat(filePath)
      if (fileStat.isDirectory()) {
        filePath = path.join(filePath, 'index.html')
        fileStat = await stat(filePath)
      }
      const ext = path.extname(filePath)
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
      const content = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(content)
    } catch {
      try {
        const indexPath = path.join(webDistDir, 'index.html')
        const content = await readFile(indexPath)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(content)
      } catch {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!DOCTYPE html><html><head><title>Conclave Core</title></head><body><h1>Conclave Core Running</h1><p>Web dist not built yet. Run <code>pnpm --filter @conclave/web build</code> or run Vite dev server at <a href="http://127.0.0.1:5173/?port=${serverPort}&token=${token}">http://127.0.0.1:5173/?port=${serverPort}&token=${token}</a>.</p></body></html>`)
      }
    }
  }

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res)
  })

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 4 * 1024 * 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      if (tokenMatches(req.url, token)) return true
      const cookieHeader = req.headers.cookie
      if (cookieHeader && cookieHeader.includes(`conclave_token=${token}`)) return true
      const isLoopback = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1'
      const host = req.headers.host
      const origin = req.headers.origin
      if (isLoopback && host && origin) {
        try {
          const originUrl = new URL(origin)
          if ((originUrl.hostname === '127.0.0.1' || originUrl.hostname === 'localhost') && originUrl.host === host) {
            return true
          }
        } catch {}
      }
      return false
    }
  })

  wss.on('connection', (socket) => {
    const send = (frame: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame)
      }
    }
    const closeListeners = new Set<() => void>()
    const connection: Connection = {
      attached: new Set(),
      watching: new Set(),
      wiring: new Set(),
      browsing: new Set(),
      usageKinds: new Set(LEGACY_USAGE_WINDOW_KINDS),
      notify: (name, params) => send(JSON.stringify({ jsonrpc: '2.0', method: name, params })),
      onClose: (listener) => {
        closeListeners.add(listener)
        return () => closeListeners.delete(listener)
      }
    }
    connections.add(connection)
    socket.on('message', (data) => {
      void handleFrame(data.toString(), connection).then(send)
    })
    socket.on('close', () => {
      connections.delete(connection)
      closeListeners.forEach((listener) => listener())
    })
  })

  return new Promise((resolve, reject) => {
    const targetHost = options.host ?? '127.0.0.1'
    httpServer.once('error', reject)
    httpServer.listen(options.port, targetHost, () => {
      const address = httpServer.address()
      const port = address !== null && typeof address === 'object' ? address.port : options.port
      serverPort = port
      const lanIp = getLanIp()
      console.log(`Conclave Core listening on ${targetHost}:${port}`)
      console.log(`  ➜  Local:   http://127.0.0.1:${port}/conclave?token=${token}`)
      if (lanIp && (targetHost === '0.0.0.0' || targetHost === lanIp)) {
        console.log(`  ➜  Network: http://${lanIp}:${port}/conclave?token=${token}`)
      }
      resolve({
        host: targetHost,
        port,
        connections,
        broadcast: (name, params) => connections.forEach((c) => c.notify(name, params)),
        close: () =>
          new Promise((done) => {
            wss.clients.forEach((client) => client.terminate())
            wss.close(() => {
              httpServer.close(() => done())
            })
          })
      })
    })
  })
}
