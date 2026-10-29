import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeMcpServer } from './mcp-probe'

// A server that answers as an MCP server does, and says on stderr which token it was given.
const SERVER = `
const readline = require('node:readline')
console.error('token ' + process.env.TOKEN)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  const out = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
  if (m.method === 'initialize') out({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } })
  else if (m.method === 'tools/list' && !m.params.cursor) out({ tools: [{ name: 'search', description: 'Searches the docs' }], nextCursor: 'p2' })
  else if (m.method === 'tools/list') out({ tools: [{ name: 'read' }] })
})
`

let http: Server | null = null
afterEach(() => { http?.close(); http = null })

describe('probing an MCP server', () => {
  it('starts a command with its env and lists every page of its tools', async () => {
    const probe = await probeMcpServer({ name: 'docs', transport: { type: 'stdio', command: process.execPath, args: ['-e', SERVER], cwd: null, env: { TOKEN: 'abc' } } }, () => 1)
    expect(probe).toEqual({ ok: true, tools: [{ name: 'search', description: 'Searches the docs' }, { name: 'read', description: '' }], error: null, stderr: 'token abc', at: 1 })
  })

  it('says why a command could not be reached, with what it printed', async () => {
    const exits = await probeMcpServer({ name: 'broken', transport: { type: 'stdio', command: process.execPath, args: ['-e', 'console.error("missing GITHUB_TOKEN"); process.exit(3)'], cwd: null, env: {} } })
    expect(exits).toMatchObject({ ok: false, error: expect.stringContaining('进程退出了（3）'), stderr: 'missing GITHUB_TOKEN' })
    const missing = await probeMcpServer({ name: 'none', transport: { type: 'stdio', command: '/no/such/command', args: [], cwd: null, env: {} } })
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('启动不了 /no/such/command') })
    const silent = await probeMcpServer({ name: 'silent', transport: { type: 'stdio', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: null, env: {} } }, Date.now, 300)
    expect(silent).toMatchObject({ ok: false, error: '0 秒内没有回应' })
  })

  it('reaches a server over HTTP with its headers', async () => {
    http = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        if (request.headers.authorization !== 'Bearer t') return response.writeHead(401).end('no token')
        const message = JSON.parse(body)
        if (message.id === undefined) return response.writeHead(202).end()
        const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { tools: [{ name: 'fetch', description: 'Fetches a page' }] }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      })
    })
    await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`
    expect(await probeMcpServer({ name: 'web', transport: { type: 'http', url, headers: { authorization: 'Bearer t' } } })).toMatchObject({ ok: true, tools: [{ name: 'fetch' }] })
    expect(await probeMcpServer({ name: 'web', transport: { type: 'http', url, headers: {} } })).toMatchObject({ ok: false, error: '初始化失败：HTTP 401：no token' })
  })
})
