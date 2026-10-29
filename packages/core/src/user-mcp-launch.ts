import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { conclavePaths, planLaunch } from '@conclave/protocol/node'
import { CredentialStore } from './credential-store'
import { McpHttpSession } from './mcp-http'
import { ReadOnlyToolFilter } from './mcp-read-only-filter'
import { McpServerStore, type ResolvedMcpServer } from './mcp-servers'
import { PROVIDER_KEY_ENV, PROVIDER_MARK_ENV } from './provider-launch'

// What an agent starts in place of one of the user's MCP servers (mcp-main --run): it reads the
// server and its secrets from Conclave's files, so neither the agent's configuration, its command line
// nor Conclave's logs ever hold them. A command is started with its env added and the agent's stdio
// handed straight to it; an address is reached over HTTP, this process carrying the messages.
// readOnly: the agent sees and calls only the server's read-only tools (see ReadOnlyToolFilter), so
// this process carries a command's messages too.
export async function runUserMcp(home: string, name: string, readOnly = false): Promise<void> {
  const paths = conclavePaths(home)
  const credentials = new CredentialStore(paths.credentials)
  await credentials.load()
  const store = new McpServerStore(paths.mcpServers, credentials)
  await store.load()
  const server = store.resolve(name)
  if (!server) throw new Error(`Conclave 里没有名为 ${name} 的 MCP 服务器`)
  const filter = readOnly ? new ReadOnlyToolFilter() : null
  if (server.transport.type === 'stdio') await runCommand(server.transport, filter)
  else await bridge(server.transport, filter)
}

const writeLine = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)

// One line from the agent as a message, or null for one that is not a JSON-RPC message.
function agentMessage(line: string): Record<string, unknown> | null {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    console.error('conclave mcp: 收到的不是 JSON-RPC 消息，已忽略')
    return null
  }
  return message && typeof message === 'object' && !Array.isArray(message) ? Object.fromEntries(Object.entries(message)) : null
}

// What the user's server starts with of this launcher's environment. ELECTRON_RUN_AS_NODE is set
// where the launcher runs as Conclave's bundled Node, which the server is not. An agent on a model
// provider passes its environment on, the provider's key with it, which the server is not given;
// nor where ZCode's file with the key is (zcode-provider.ts).
export function serverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _ours, ...rest } = env
  if (!rest[PROVIDER_MARK_ENV]) return rest
  const {
    [PROVIDER_KEY_ENV]: _key, [PROVIDER_MARK_ENV]: _mark, ANTHROPIC_AUTH_TOKEN: _token, ANTHROPIC_API_KEY: _apiKey,
    ZCODE_DATA_BASE_DIR: _data, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: _providers, ZCODE_CLI_CREDENTIALS_FILE: _credentials,
    ...clean
  } = rest
  return clean
}

function runCommand(transport: Extract<ResolvedMcpServer['transport'], { type: 'stdio' }>, filter: ReadOnlyToolFilter | null): Promise<void> {
  const env = serverEnv(process.env)
  const cwd = transport.cwd ?? process.cwd()
  const launch = planLaunch(transport.command, transport.args, cwd, { ...env, ...transport.env })
  const child = spawn(launch.file, launch.args, { cwd, env: launch.env, stdio: filter ? ['pipe', 'pipe', 'inherit'] : 'inherit', windowsHide: true })
  if (filter && child.stdin && child.stdout) {
    relay(child.stdin, child.stdout, filter)
    // Once the server is gone and its last words passed on, so is this end: the agent sees it exit.
    child.on('close', () => process.stdin.destroy())
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal))
  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`启动不了 ${transport.command}：${error.message}`)))
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0)
      resolve()
    })
  })
}

// Carries a command's messages line by line through the filter. Anything that is not one message (a
// batch, a stray line) does not reach the server, so nothing gets past the filter that way.
function relay(input: Writable, output: Readable, filter: ReadOnlyToolFilter): void {
  output.on('error', () => {})
  input.on('error', () => {})
  void (async () => {
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      const message = agentMessage(line)
      if (!message) continue
      const passed = filter.fromAgent(message)
      if ('reply' in passed) writeLine(passed.reply)
      else input.write(`${JSON.stringify(passed.forward)}\n`)
    }
    input.end()
  })()
  void (async () => {
    for await (const line of readline.createInterface({ input: output, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        process.stdout.write(`${line}\n`)
        continue
      }
      writeLine(message && typeof message === 'object' && !Array.isArray(message) ? filter.fromServer(Object.fromEntries(Object.entries(message))) : message)
    }
  })()
}

// The agent's side is newline-delimited JSON-RPC on stdio, as for any command; each message goes
// out as a request of its own, so a slow tool call holds up nothing else.
async function bridge(transport: Extract<ResolvedMcpServer['transport'], { type: 'http' }>, filter: ReadOnlyToolFilter | null): Promise<void> {
  const session = new McpHttpSession(transport.url, transport.headers)
  const write = (message: Record<string, unknown>) => writeLine(filter ? filter.fromServer(message) : message)
  const inFlight = new Set<Promise<void>>()
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue
    const message = agentMessage(line)
    if (!message) continue
    const passed = filter ? filter.fromAgent(message) : { forward: message }
    if ('reply' in passed) {
      writeLine(passed.reply)
      continue
    }
    const sent = session.send(passed.forward, write).catch((error: unknown) => {
      console.error(`conclave mcp: ${error instanceof Error ? error.message : String(error)}`)
    })
    inFlight.add(sent)
    void sent.finally(() => inFlight.delete(sent))
  }
  await Promise.all(inFlight)
  await session.close()
}
