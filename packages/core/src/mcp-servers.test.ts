import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpServer, McpServerInput } from '@conclave/protocol'
import { CredentialStore } from './credential-store'
import { McpServerStore } from './mcp-servers'

let dir: string
let credentials: CredentialStore
let changes: McpServer[][]
let store: McpServerStore

const command = { type: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], cwd: null, env: [{ key: 'GITHUB_TOKEN', value: 'ghp_secret' }] }
const github: McpServerInput = { name: 'github', previousName: null, enabled: true, agents: ['claude', 'cursor'], transport: command }

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-mcp-'))
  credentials = new CredentialStore(path.join(dir, 'credentials.json'))
  changes = []
  store = new McpServerStore(path.join(dir, 'mcp-servers.json'), credentials, (servers) => changes.push([...servers]))
  await store.load()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('MCP server store', () => {
  it('keeps the settings in its file and the env values among the credentials', async () => {
    const saved = await store.save(github)
    expect(saved.transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], cwd: null, envKeys: ['GITHUB_TOKEN'] })
    expect(readFileSync(path.join(dir, 'mcp-servers.json'), 'utf8')).not.toContain('ghp_secret')
    expect(readFileSync(path.join(dir, 'credentials.json'), 'utf8')).toContain('ghp_secret')
    expect(changes).toHaveLength(1)

    const reloaded = new McpServerStore(path.join(dir, 'mcp-servers.json'), credentials)
    await reloaded.load()
    expect(reloaded.list().map((server) => server.name)).toEqual(['github'])
  })

  it('hands an agent the enabled servers picked for it, and a launcher their values', async () => {
    await store.save(github)
    expect(store.forAgent('claude').map((server) => server.name)).toEqual(['github'])
    expect(store.resolve('github')).toEqual({ name: 'github', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], cwd: null, env: { GITHUB_TOKEN: 'ghp_secret' } } })
    expect(store.forAgent('codex')).toEqual([])
    await store.setEnabled('github', false)
    expect(store.forAgent('claude')).toEqual([])
  })

  it('keeps a stored value an edit leaves out, and drops a key the edit removes', async () => {
    await store.save({ ...github, transport: { ...command, env: [{ key: 'GITHUB_TOKEN', value: 'ghp_secret' }, { key: 'GITHUB_HOST', value: 'github.com' }] } })
    await store.save({ ...github, previousName: 'github', transport: { ...command, env: [{ key: 'GITHUB_TOKEN', value: null }] } })
    expect(store.resolve('github')?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_secret' } })
    expect(readFileSync(path.join(dir, 'credentials.json'), 'utf8')).not.toContain('github.com')
  })

  it('carries the secrets over a rename and keeps the server in its place', async () => {
    await store.save(github)
    await store.save({ ...github, name: 'docs', transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: [] } })
    await store.save({ ...github, name: 'gh', previousName: 'github', transport: { ...command, env: [{ key: 'GITHUB_TOKEN', value: null }] } })
    expect(store.list().map((server) => server.name)).toEqual(['gh', 'docs'])
    expect(store.resolve('gh')?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_secret' } })
    expect(credentials.get('mcp', 'github')).toBeNull()
  })

  it('refuses a taken name, a missing value and a token sent in the clear', async () => {
    await store.save(github)
    await expect(store.save(github)).rejects.toMatchObject({ reason: 'mcp-name-taken' })
    await expect(store.save({ ...github, name: 'other', transport: { ...command, env: [{ key: 'TOKEN', value: null }] } })).rejects.toMatchObject({ reason: 'mcp-secret-missing' })
    await expect(store.save({ ...github, name: 'remote', transport: { type: 'http', url: 'http://mcp.example.com/mcp', headers: [] } })).rejects.toMatchObject({ reason: 'mcp-insecure-url' })
    await expect(store.save({ ...github, name: 'local', transport: { type: 'http', url: 'http://127.0.0.1:3000/mcp', headers: [] } })).resolves.toMatchObject({ name: 'local' })
  })

  it('removes a server with its secrets', async () => {
    await store.save(github)
    await store.remove('github')
    expect(store.list()).toEqual([])
    expect(credentials.get('mcp', 'github')).toBeNull()
  })
})
