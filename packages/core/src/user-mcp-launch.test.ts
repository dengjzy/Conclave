import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conclavePaths } from '@conclave/protocol/node'
import type { McpServerInput } from '@conclave/protocol'
import { CredentialStore } from './credential-store'
import { mcpCommand } from './mcp-command'
import { McpHttpSession } from './mcp-http'
import { McpServerStore } from './mcp-servers'
import { serverEnv } from './user-mcp-launch'

let home: string
let http: Server | null = null

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'conclave-mcp-launch-'))
  // Source checkouts must ignore a bundle inherited from the installed app that starts them.
  vi.stubEnv('CONCLAVE_MCP_JS', path.join(home, 'installed', 'mcp.mjs'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  http?.close()
  http = null
  rmSync(home, { recursive: true, force: true })
})

async function save(input: McpServerInput): Promise<void> {
  const paths = conclavePaths(home)
  const credentials = new CredentialStore(paths.credentials)
  await credentials.load()
  const store = new McpServerStore(paths.mcpServers, credentials)
  await store.load()
  await store.save(input)
}

// Starts the launcher as an agent would, writes these lines to it and reads as many back. Stepwise,
// each line after the one before is answered, as an agent calls a tool once it has the list.
async function exchange(name: string, lines: readonly unknown[], expected: number, { flags = [], stepwise = false }: { flags?: string[]; stepwise?: boolean } = {}): Promise<unknown[]> {
  const { command, args } = mcpCommand('--home', home, '--run', name, ...flags)
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  const replies: unknown[] = []
  const done = new Promise<unknown[]>((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('exit', () => (replies.length >= expected ? resolve(replies) : reject(new Error(`launcher exited: ${stderr}`))))
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      replies.push(JSON.parse(line))
      const next = lines[replies.length]
      if (stepwise && next !== undefined) child.stdin.write(`${JSON.stringify(next)}\n`)
      if (replies.length === expected) {
        child.stdin.end()
        resolve(replies)
      }
    })
  })
  for (const line of stepwise ? lines.slice(0, 1) : lines) child.stdin.write(`${JSON.stringify(line)}\n`)
  return done
}

describe('the launcher of a user\'s MCP server', () => {
  it('starts a command with its secret env added, and the agent\'s stdio handed to it', async () => {
    const script = 'process.stdin.once("data", () => { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { token: process.env.TOKEN, bundled: process.env.ELECTRON_RUN_AS_NODE ?? null } }) + "\\n"); process.exit(0) })'
    await save({ name: 'echo', previousName: null, enabled: true, agents: ['claude'], transport: { type: 'stdio', command: process.execPath, args: ['-e', script], cwd: null, env: [{ key: 'TOKEN', value: 'secret-token' }] } })
    expect(await exchange('echo', [{ jsonrpc: '2.0', id: 1, method: 'ping' }], 1)).toEqual([{ jsonrpc: '2.0', id: 1, result: { token: 'secret-token', bundled: null } }])
  })

  it('hands an agent that may only read the server\'s read-only tools, and refuses a call to any other', async () => {
    const script = `require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line)
      const result = m.method === "tools/list"
        ? { tools: [{ name: "search", annotations: { readOnlyHint: true } }, { name: "create_issue", annotations: { readOnlyHint: false } }, { name: "plain" }] }
        : { called: m.params.name }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n")
    })`
    await save({ name: 'jira', previousName: null, enabled: true, agents: ['claude'], transport: { type: 'stdio', command: process.execPath, args: ['-e', script], cwd: null, env: [] } })
    const call = (id: number, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
    const replies = await exchange('jira', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'create_issue'), call(3, 'plain'), call(4, 'search')], 4, { flags: ['--read-only'], stepwise: true })
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search', annotations: { readOnlyHint: true } }] } },
      { jsonrpc: '2.0', id: 2, error: expect.objectContaining({ code: -32602 }) },
      { jsonrpc: '2.0', id: 3, error: expect.objectContaining({ code: -32602 }) },
      { jsonrpc: '2.0', id: 4, result: { called: 'search' } }
    ])
  })

  it('carries messages to a server over HTTP with its headers and session', async () => {
    const seen: IncomingHttpHeaders[] = []
    http = createServer((request, response) => {
      seen.push(request.headers)
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        const message = JSON.parse(body)
        if (message.method === 'initialize') {
          response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }))
        } else if (message.id === undefined) {
          response.writeHead(202).end()
        } else {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search' }] } })}\n\n`)
        }
      })
    })
    await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await save({ name: 'docs', previousName: null, enabled: true, agents: ['claude'], transport: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: [{ key: 'Authorization', value: 'Bearer secret' }] } })
    const replies = await exchange('docs', [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } }
    ], 1)
    expect(replies).toMatchObject([{ id: 1, result: { serverInfo: { name: 'test' } } }])
    expect(seen[0]?.authorization).toBe('Bearer secret')
  })
})

describe('an MCP session over HTTP', () => {
  it('names the session and revision on later requests, and reads an event stream', async () => {
    const calls: { headers: Record<string, string>; body: unknown }[] = []
    const reply = (status: number, body: string, headers: Record<string, string>) => new Response(body, { status, headers })
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = Object.fromEntries(Object.entries(init?.headers ?? {}))
      const body = JSON.parse(String(init?.body))
      calls.push({ headers, body })
      if (body.method === 'initialize') return reply(200, JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }), { 'content-type': 'application/json', 'mcp-session-id': 's-9' })
      if (body.id === undefined) return reply(202, '', {})
      return reply(200, `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} })}\n\n`, { 'content-type': 'text/event-stream' })
    }
    const session = new McpHttpSession('https://mcp.example.com/mcp', { authorization: 'Bearer t' }, fetchImpl)
    const received: unknown[] = []
    await session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, (message) => received.push(message))
    await session.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, (message) => received.push(message))
    await session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, (message) => received.push(message))
    expect(received).toMatchObject([{ id: 1 }, { method: 'notifications/progress' }, { id: 2 }])
    expect(calls[2]?.headers).toMatchObject({ authorization: 'Bearer t', 'mcp-session-id': 's-9', 'mcp-protocol-version': '2025-03-26' })
  })

  it('answers a request the server refused with an error, so nobody waits on it', async () => {
    const fetchImpl: typeof fetch = async () => new Response('unauthorized', { status: 401 })
    const received: unknown[] = []
    await expect(new McpHttpSession('https://mcp.example.com/mcp', {}, fetchImpl).send({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, (message) => received.push(message))).rejects.toThrow('HTTP 401')
    expect(received).toEqual([{ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'HTTP 401：unauthorized' } }])
  })
})

describe('the environment a user server starts with', () => {
  it('leaves out an agent provider key and where ZCode keeps one', () => {
    const env = {
      PATH: '/bin', CONCLAVE_MODEL_PROVIDER: 'zhipu-glm-coding', CONCLAVE_MODEL_PROVIDER_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 'sk', ELECTRON_RUN_AS_NODE: '1',
      ZCODE_DATA_BASE_DIR: '/s/launch/x', ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/s/launch/x/.zcode/v2/provider_config.json', ZCODE_CLI_CREDENTIALS_FILE: '/s/launch/x/.zcode/v2/credentials.json'
    }
    expect(serverEnv(env)).toEqual({ PATH: '/bin' })
    // Off a provider, the user's own ZCode settings are theirs to pass on.
    expect(serverEnv({ PATH: '/bin', ZCODE_DATA_BASE_DIR: '/home/u' })).toEqual({ PATH: '/bin', ZCODE_DATA_BASE_DIR: '/home/u' })
  })
})
