import path from 'node:path'
import { z } from 'zod'
import { McpServer, type AgentKind, type McpImportCandidate, type McpImportItem, type McpProbe, type McpSecretInput, type McpServerInput, type McpTransport } from '@conclave/protocol'
import { readJsonIfExists, writePrivateJson } from '@conclave/protocol/node'
import type { CredentialStore } from './credential-store'
import { findAgentMcpServers, importCandidate, importInput, type FoundMcpServer } from './mcp-import'
import { probeMcpServer } from './mcp-probe'
import { Rejection } from './rejection'

const Saved = z.object({ version: z.literal(1), servers: z.array(McpServer) })

// The secrets of one server, under the credential store's `mcp` provider: env and header values
// side by side, told apart by prefix.
const PROVIDER = 'mcp'
const envKey = (key: string) => `env:${key}`
const headerKey = (name: string) => `header:${name}`

// A server with its secrets, for whatever starts or reaches it; never sent to a client.
export type ResolvedMcpServer = {
  name: string
  transport:
    | { type: 'stdio'; command: string; args: string[]; cwd: string | null; env: Record<string, string> }
    | { type: 'http'; url: string; headers: Record<string, string> }
}

// The user's MCP servers. Settings sit in one file, the values of their env and headers in the
// credential store, so the file holds nothing secret. Changes run one at a time: a rename moves
// secrets from one name to another, which another change must not interleave with.
export class McpServerStore {
  private servers: McpServer[] = []
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly credentials: CredentialStore,
    private readonly changed: (servers: readonly McpServer[]) => void = () => {},
    // Where the agents' own servers are read from; tests give their own.
    private readonly find: () => Promise<FoundMcpServer[]> = () => findAgentMcpServers()
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readJsonIfExists(this.file)
      const parsed = raw === undefined ? null : Saved.safeParse(raw)
      if (parsed && !parsed.success) console.error(`[conclave-core] ${this.file} is not a list of MCP servers; ignoring it until one is saved`)
      this.servers = parsed?.success ? parsed.data.servers : []
    } catch (error) {
      console.error(`[conclave-core] cannot read ${this.file}:`, error instanceof Error ? error.message : error)
      this.servers = []
    }
  }

  list(): readonly McpServer[] { return this.servers }

  // What an agent of this kind is handed at its start.
  forAgent(agent: AgentKind): McpServer[] {
    return this.servers.filter((server) => server.enabled && server.agents.includes(agent))
  }

  resolve(name: string): ResolvedMcpServer | null {
    const server = this.servers.find((each) => each.name === name)
    return server ? this.resolved(server) : null
  }

  private resolved(server: McpServer): ResolvedMcpServer {
    const secrets = this.credentials.get(PROVIDER, server.name)?.payload ?? {}
    const pick = (keys: readonly string[], key: (name: string) => string) =>
      Object.fromEntries(keys.flatMap((name) => { const value = secrets[key(name)]; return value === undefined ? [] : [[name, value]] }))
    const transport = server.transport
    return {
      name: server.name,
      transport: transport.type === 'stdio'
        ? { type: 'stdio', command: transport.command, args: transport.args, cwd: transport.cwd, env: pick(transport.envKeys, envKey) }
        : { type: 'http', url: transport.url, headers: pick(transport.headerKeys, headerKey) }
    }
  }

  async importable(): Promise<McpImportCandidate[]> {
    return (await this.find()).map((found) => importCandidate(found, this.servers))
  }

  // Each one read again from its agent's configuration, values and all, and saved in turn: the
  // ones before a refusal stay.
  async import(items: readonly McpImportItem[], agents: readonly AgentKind[]): Promise<McpServer[]> {
    const found = await this.find()
    const saved: McpServer[] = []
    for (const item of items) {
      const server = found.find((each) => each.source === item.source && each.name === item.name)
      if (!server) throw new Rejection('mcp-import-gone', `${item.name} 已经不在 ${item.source} 的配置里了`)
      saved.push(await this.save(importInput(server, item, agents)))
    }
    return saved
  }

  // Reached as an agent would reach it, with its secrets.
  probe(name: string): Promise<McpProbe> {
    this.require(name)
    const server = this.resolve(name)
    if (!server) throw new Rejection('mcp-unknown', '没有这个 MCP 服务器')
    return probeMcpServer(server)
  }

  private serially<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.catch(() => {}).then(action)
    this.chain = result
    return result
  }

  private require(name: string): McpServer {
    const server = this.servers.find((each) => each.name === name)
    if (!server) throw new Rejection('mcp-unknown', '没有这个 MCP 服务器')
    return server
  }

  private async write(servers: McpServer[]): Promise<void> {
    await writePrivateJson(this.file, { version: 1, servers })
    this.servers = servers
    this.changed(servers)
  }

  save(input: McpServerInput): Promise<McpServer> {
    return this.serially(async () => {
      const previous = input.previousName === null ? null : this.require(input.previousName)
      if (input.name !== input.previousName && this.servers.some((each) => each.name === input.name)) {
        throw new Rejection('mcp-name-taken', '已经有同名的 MCP 服务器')
      }
      const stored = previous ? this.credentials.get(PROVIDER, previous.name)?.payload ?? {} : {}
      const secrets: Record<string, string> = {}
      const take = (entries: readonly McpSecretInput[], key: (name: string) => string): string[] => {
        const keys = entries.map((entry) => entry.key)
        if (new Set(keys).size !== keys.length) throw new Rejection('mcp-duplicate-key', '同一个键填了两次')
        for (const entry of entries) {
          const value = entry.value ?? stored[key(entry.key)]
          if (value === undefined) throw new Rejection('mcp-secret-missing', `${entry.key} 还没有填值`)
          secrets[key(entry.key)] = value
        }
        return keys
      }
      const given = input.transport
      const transport: McpTransport = given.type === 'stdio'
        ? { type: 'stdio', command: given.command, args: given.args, cwd: given.cwd || null, envKeys: take(given.env, envKey) }
        : { type: 'http', url: checkUrl(given.url), headerKeys: take(given.headers, headerKey) }
      if (transport.type === 'stdio' && transport.cwd !== null && !path.isAbsolute(transport.cwd)) {
        throw new Rejection('mcp-relative-cwd', '工作目录要写绝对路径')
      }
      const now = Date.now()
      const server: McpServer = { name: input.name, enabled: input.enabled, agents: [...new Set(input.agents)], transport, createdAt: previous?.createdAt ?? now, updatedAt: now }
      // Secrets first: a list that names a server whose secrets were not written would start it without them.
      if (Object.keys(secrets).length > 0) {
        await this.credentials.set(PROVIDER, server.name, { kind: 'mcp', payload: secrets, account: null, updatedAt: now })
      } else if (this.credentials.get(PROVIDER, server.name)) {
        await this.credentials.delete(PROVIDER, server.name)
      }
      const rest = this.servers.filter((each) => each.name !== previous?.name && each.name !== server.name)
      const at = previous ? this.servers.indexOf(previous) : this.servers.length
      await this.write([...rest.slice(0, at), server, ...rest.slice(at)])
      if (previous && previous.name !== server.name && this.credentials.get(PROVIDER, previous.name)) {
        await this.credentials.delete(PROVIDER, previous.name)
      }
      return server
    })
  }

  setEnabled(name: string, enabled: boolean): Promise<McpServer> {
    return this.serially(async () => {
      const server = { ...this.require(name), enabled, updatedAt: Date.now() }
      await this.write(this.servers.map((each) => (each.name === name ? server : each)))
      return server
    })
  }

  remove(name: string): Promise<void> {
    return this.serially(async () => {
      this.require(name)
      await this.write(this.servers.filter((each) => each.name !== name))
      if (this.credentials.get(PROVIDER, name)) await this.credentials.delete(PROVIDER, name)
    })
  }
}

// Plain http only to this machine: a token sent to anywhere else must go encrypted.
function checkUrl(url: string): string {
  const parsed = new URL(url)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new Rejection('mcp-insecure-url', '远程服务器只接受 https://，http:// 只能连本机')
  }
  return parsed.href
}
