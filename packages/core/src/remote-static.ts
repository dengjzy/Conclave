import { randomUUID } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultWebDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
const contentTypes: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://tailcat.dev wss:; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

async function containedFile(root: string, filename: string): Promise<Buffer> {
  const location = await realpath(path.join(root, filename))
  const relative = path.relative(root, location)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('手机静态资源超出允许目录。')
  return readFile(location)
}

export async function createRemoteStaticServer(options: {
  assetsDirectory: string
  webDirectory?: string
  onError?: () => void
}): Promise<{ origin: string; html: Buffer; instance: string; setPublicOrigin(url: string): void; close(): Promise<void> }> {
  const webRoot = await realpath(options.webDirectory ?? defaultWebDirectory)
  const runtimeRoot = await realpath(options.assetsDirectory)
  const html = await containedFile(webRoot, 'remote.html')
  const mobile = await containedFile(webRoot, 'mobile.html')
  const files = new Map<string, { data: Buffer; type: string }>([
    ['/', { data: html, type: 'text/html; charset=utf-8' }],
    ['/conclave', { data: html, type: 'text/html; charset=utf-8' }],
    ['/conclave/', { data: html, type: 'text/html; charset=utf-8' }],
    ['/remote.html', { data: html, type: 'text/html; charset=utf-8' }],
    ['/mobile.html', { data: mobile, type: 'text/html; charset=utf-8' }],
    ['/assets/main.wasm.gz', { data: await containedFile(runtimeRoot, 'main.wasm.gz'), type: 'application/gzip' }],
    ['/assets/wasm_exec.js', { data: await containedFile(runtimeRoot, 'wasm_exec.js'), type: 'text/javascript; charset=utf-8' }],
  ])
  // Snapshot only flat build assets. Requests never resolve arbitrary filesystem paths.
  for (const entry of await readdir(path.join(webRoot, 'assets'), { withFileTypes: true })) {
    const type = contentTypes[path.extname(entry.name)]
    if (!entry.isFile() || !type || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue
    const key = `/assets/${entry.name}`
    const data = await containedFile(webRoot, `assets/${entry.name}`)
    const reserved = files.get(key)
    if (reserved) {
      if (!reserved.data.equals(data)) throw new Error('手机构建资源与远程运行时文件不匹配。')
      continue
    }
    files.set(key, { data, type })
  }
  const instance = randomUUID()
  const allowedHosts = new Set<string>()
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', csp)
    response.setHeader('X-Conclave-Static-Instance', instance)
    const missing = () => { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found') }
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !allowedHosts.has((request.headers.host ?? '').toLowerCase())) { missing(); return }
    let pathname: string
    try { pathname = decodeURIComponent((request.url ?? '').split('?')[0] ?? '') } catch { missing(); return }
    const file = files.get(pathname)
    if (!file) { missing(); return }
    if (pathname.startsWith('/assets/') && pathname !== '/assets/main.wasm.gz' && pathname !== '/assets/wasm_exec.js') response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.data.length })
    response.end(request.method === 'HEAD' ? undefined : file.data)
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  server.on('error', () => options.onError?.())
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('手机静态服务未能监听本机端口。') }
  const origin = `http://127.0.0.1:${address.port}`
  allowedHosts.add(new URL(origin).host)
  let closing: Promise<void> | undefined
  return {
    origin, html, instance,
    setPublicOrigin(url) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(parsed.hostname)) throw new Error('公网手机地址不合法。')
      allowedHosts.add(parsed.host)
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
      return closing
    },
  }
}
