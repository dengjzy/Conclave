import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccounts, AgentUsage, Terminal } from '@conclave/protocol'
import type { SessionInfo } from '@conclave/protocol/node'
import { AgentAccountStore, type AccountDeps } from './agent-accounts'
import { agentCliAccess } from './agent-cli-access'
import { antigravityAccounts } from './agents/antigravity/antigravity-account'
import { UsageService } from './usage-service'
import type { UsageReading } from './usage-source'

const NOW = 1_790_000_000_000

const usage = (account: string, usedPercent: number): AgentUsage => ({
  agent: 'claude', account, status: 'ok', plan: null, error: null, updatedAt: NOW, resetCredits: null,
  windows: [{ kind: 'session', model: null, usedPercent, windowMinutes: 300, resetsAt: NOW + 3_600_000 }]
})

describe('accounts whose running processes can write credentials', () => {
  let root: string
  let sessions: SessionInfo[]
  let exits: Array<(code?: number) => void>
  let changed: ReturnType<typeof vi.fn<AccountDeps['accountChanged']>>
  const terminal: Terminal = { id: 'login', sessionId: 'login-process', cwd: '/tmp', title: 'login', createdAt: 0 }
  let signIn: ReturnType<typeof vi.fn<() => Promise<Terminal>>>
  let processes: ReturnType<typeof vi.fn<() => Promise<readonly SessionInfo[]>>>
  const store = () => new AgentAccountStore(path.join(root, 'accounts.json'), path.join(root, 'accounts'), {
    signIn,
    waitForExit: () => new Promise((resolve) => exits.push((code = 0) => resolve(code))),
    processes,
    accountChanged: changed,
    changed: () => {},
    newId: () => 'work'
  })
  const process = (fields: Partial<SessionInfo>): SessionInfo => ({ sessionId: 'agent-process', exited: false, exitCode: null, io: 'pipe', ...fields })

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-credential-guard-'))
    vi.stubEnv('GEMINI_HOME', path.join(root, 'own'))
    vi.spyOn(antigravityAccounts, 'loginCommand').mockResolvedValue({ command: 'login', args: [] })
    sessions = []
    exits = []
    changed = vi.fn<AccountDeps['accountChanged']>()
    signIn = vi.fn(async () => terminal)
    processes = vi.fn(async () => sessions)
  })

  afterEach(async () => {
    sessions = []
    exits.splice(0).forEach((exit) => exit())
    await vi.waitFor(() => expect(agentCliAccess.blocked('antigravity')).toBe(false))
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    { agent: 'antigravity' as const },
    { io: 'pipe' as const }
  ])('refuses credential changes while a daemon process can still write them: %j', async (fields) => {
    const accounts = store()
    await accounts.load()
    sessions = [process(fields)]
    await expect(accounts.login('antigravity', 'default')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    expect(signIn).not.toHaveBeenCalled()
    expect(agentCliAccess.blocked('antigravity')).toBe(false)
    sessions = []
    await accounts.login('antigravity', 'default')
    expect(signIn).toHaveBeenCalledOnce()
  })

  it('holds the reservation through login and rejects launches, a second login and removal', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('antigravity', 'Work')
    expect(agentCliAccess.blocked('antigravity')).toBe(true)
    await expect(accounts.launch('antigravity', 'work')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    await expect(accounts.login('antigravity', 'work')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    await expect(accounts.remove('antigravity', 'work')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    expect(signIn).toHaveBeenCalledOnce()
    exits.shift()?.(1)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('antigravity', 'work', false))
    expect(agentCliAccess.blocked('antigravity')).toBe(false)
    await expect(accounts.launch('antigravity', 'work')).resolves.toMatchObject({ id: 'work' })
    await accounts.remove('antigravity', 'work')
    expect(accounts.list().accounts.some((account) => account.agent === 'antigravity' && account.id === 'work')).toBe(false)
  })

  it('refuses removal until existing daemon writers exit without dropping their credentials', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('antigravity', 'Work')
    exits.shift()?.()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    const file = path.join(root, 'accounts/antigravity/work/antigravity-acp/acp_token.json')
    writeFileSync(file, '{"retained":true}')
    sessions = [process({ agent: 'antigravity' })]
    await expect(accounts.remove('antigravity', 'work')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    expect(existsSync(file)).toBe(true)
    expect(agentCliAccess.blocked('antigravity')).toBe(false)
    sessions = []
    await accounts.remove('antigravity', 'work')
    expect(existsSync(file)).toBe(false)
  })

  it('blocks a recovered login PTY after core restarts, while allowing normal agent processes', async () => {
    const accounts = store()
    await accounts.load()
    sessions = [process({ agent: 'antigravity', io: 'pty' })]
    await expect(accounts.launch('antigravity')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    sessions = [process({ agent: 'antigravity' }), process({ agent: 'claude', io: 'pty' })]
    await expect(accounts.launch('antigravity')).resolves.toEqual({ id: 'default', env: null })
    sessions = [process({ agent: 'antigravity', io: 'pty', exited: true, exitCode: 0 })]
    await expect(accounts.launch('antigravity')).resolves.toEqual({ id: 'default', env: null })
  })

  it('migrates an old account home only after reserving launches and confirming its writers have exited', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('antigravity', 'Work')
    exits.shift()?.()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    vi.spyOn(antigravityAccounts, 'needsIdlePreparation').mockResolvedValue(true)
    const prepare = vi.spyOn(antigravityAccounts, 'prepare').mockImplementation(async () => {
      expect(agentCliAccess.blocked('antigravity')).toBe(true)
    })
    sessions = [process({ agent: 'antigravity' })]
    await expect(accounts.launch('antigravity', 'work')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    await expect(accounts.login('antigravity', 'work')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    expect(prepare).not.toHaveBeenCalled()
    expect(sessions).toHaveLength(1)
    sessions = []
    await expect(accounts.launch('antigravity', 'work')).resolves.toMatchObject({ id: 'work' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(agentCliAccess.blocked('antigravity')).toBe(false)
  })

  it('removes credentials and the account registry while retaining history owned by its conversations', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('antigravity', 'Work')
    exits.shift()?.()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    const home = path.join(root, 'accounts/antigravity/work/antigravity-acp')
    const artifact = path.join(home, 'brain', 'session', 'artifact.txt')
    mkdirSync(path.dirname(artifact), { recursive: true })
    writeFileSync(artifact, 'owned history')
    writeFileSync(path.join(home, 'acp_token.json'), 'credential')
    await accounts.remove('antigravity', 'work')
    expect(existsSync(artifact)).toBe(true)
    expect(existsSync(path.join(home, 'acp_token.json'))).toBe(false)
    expect(accounts.list().accounts.some((account) => account.agent === 'antigravity' && account.id === 'work')).toBe(false)
  })

  it('keeps the reservation when closing a login tab settles before its process exits', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.login('antigravity', 'default')
    sessions = [process({ sessionId: terminal.sessionId, agent: 'antigravity', io: 'pty' })]
    exits.shift()?.()
    await vi.waitFor(() => expect(processes.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(agentCliAccess.blocked('antigravity')).toBe(true)
    await expect(accounts.launch('antigravity')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    sessions = []
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(agentCliAccess.blocked('antigravity')).toBe(false)
  })

  it('releases a failed login reservation so the user can retry', async () => {
    const accounts = store()
    await accounts.load()
    signIn.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(accounts.login('antigravity', 'default')).rejects.toThrow('spawn failed')
    expect(agentCliAccess.blocked('antigravity')).toBe(false)
    await accounts.login('antigravity', 'default')
    expect(signIn).toHaveBeenCalledTimes(2)
  })

  it('releases a reservation if the daemon cannot confirm existing processes', async () => {
    const accounts = store()
    await accounts.load()
    processes.mockRejectedValueOnce(new Error('daemon unavailable'))
    await expect(accounts.login('antigravity', 'default')).rejects.toThrow('daemon unavailable')
    expect(agentCliAccess.blocked('antigravity')).toBe(false)
    await accounts.login('antigravity', 'default')
    expect(signIn).toHaveBeenCalledOnce()
  })
})

describe('AgentAccountStore', () => {
  let root: string
  let own: string
  let signIns: Array<{ command: string; args: readonly string[]; env: Record<string, string> }>
  let exits: Array<() => void>
  let changes: AgentAccounts[]
  let touched: Array<[string, string, boolean]>
  let ids: string[]
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }

  const store = () => new AgentAccountStore(path.join(root, 'agent-accounts.json'), path.join(root, 'agent-accounts'), {
    signIn: async (argv, env) => {
      signIns.push({ ...argv, env })
      return { id: `t${signIns.length}` } as unknown as Terminal
    },
    waitForExit: () => new Promise((resolve) => exits.push(() => resolve(0))),
    accountChanged: (agent, id, removed) => touched.push([agent, id, removed]),
    changed: (accounts) => changes.push(accounts),
    newId: () => ids.shift() ?? 'extra',
    signOut: async () => {}
  })

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-accounts-'))
    own = path.join(root, 'own-claude')
    mkdirSync(own, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = own
    process.env.CODEX_HOME = path.join(root, 'own-codex')
    vi.stubEnv('GEMINI_HOME', path.join(root, 'own-antigravity'))
    vi.stubEnv('GEMINI_CLI_HOME', path.join(root, 'own-gemini'))
    vi.stubEnv('GEMINI_API_KEY', '')
    vi.stubEnv('GOOGLE_API_KEY', '')
    signIns = []
    exits = []
    changes = []
    touched = []
    ids = ['work', 'spare']
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const [name, value] of [['CLAUDE_CONFIG_DIR', saved.claude], ['CODEX_HOME', saved.codex]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('lists the user’s own account of each agent that has accounts, active until another is picked', async () => {
    const accounts = store()
    await accounts.load()
    expect(accounts.list()).toMatchObject({
      accounts: [{ id: 'default', agent: 'claude', signedIn: false }, { id: 'default', agent: 'codex', signedIn: false }, { id: 'default', agent: 'antigravity', signedIn: false }, { id: 'default', agent: 'gemini', signedIn: false }],
      active: { claude: 'default', codex: 'default', antigravity: 'default', gemini: 'default' },
      autoSwitch: true
    })
    expect(await accounts.launch('claude')).toEqual({ id: 'default', env: null })
    expect(await accounts.launch('cursor')).toBeNull()
  })

  it('keeps polling Cursor’s own usage alongside managed accounts and after one is removed', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', 'Work')
    let now = NOW
    const claude = vi.fn(async (_home?: string): Promise<UsageReading> => ({ signedIn: true, windows: [], plan: 'max' }))
    const cursor = vi.fn(async (): Promise<UsageReading> => ({
      signedIn: true, plan: 'Pro', windows: [{ kind: 'monthly', model: null, usedPercent: 42, windowMinutes: 43_200, resetsAt: null }]
    }))
    const service = new UsageService({ claude, cursor }, () => {}, () => now, {}, () => accounts.homes())
    await service.refresh()
    expect(claude.mock.calls).toEqual([[undefined], [path.join(root, 'agent-accounts', 'claude', 'work')]])
    expect(cursor).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(service.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'claude', account: 'default', status: 'ok' }),
      expect.objectContaining({ agent: 'claude', account: 'work', status: 'ok' }),
      expect.objectContaining({ agent: 'cursor', account: 'default', status: 'ok', windows: [expect.objectContaining({ kind: 'monthly', usedPercent: 42 })] })
    ]))
    expect(accounts.list().accounts.some((account) => account.agent === 'cursor')).toBe(false)

    await accounts.remove('claude', 'work')
    now += 30_000
    await service.refresh()
    expect(cursor).toHaveBeenCalledTimes(2)
    expect(service.list().map((entry) => [entry.agent, entry.account])).toEqual([['claude', 'default'], ['cursor', 'default']])
  })

  it('adds an account by signing in, in its own folder, and reads who signed in once the terminal ends', async () => {
    const accounts = store()
    await accounts.load()
    const { account } = await accounts.add('claude', 'Work')
    const home = path.join(root, 'agent-accounts', 'claude', 'work')
    expect(account).toMatchObject({ id: 'work', label: 'Work', signedIn: false })
    expect(signIns).toEqual([{ command: 'claude', args: ['auth', 'login'], env: { CLAUDE_CONFIG_DIR: home } }])
    expect(existsSync(path.join(home, 'projects'))).toBe(true)
    writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }))
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.com' } }))
    exits.shift()?.()
    await vi.waitFor(() => expect(touched).toEqual([['claude', 'work', false]]))
    expect(accounts.list().accounts.find((each) => each.id === 'work')).toMatchObject({ signedIn: true, email: 'me@work.com' })
  })

  it('starts the agent in the active account’s folder, and keeps the pick across a restart', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', null)
    await accounts.activate('claude', 'work')
    const home = path.join(root, 'agent-accounts', 'claude', 'work')
    expect(await accounts.launch('claude')).toEqual({ id: 'work', env: { CLAUDE_CONFIG_DIR: home } })
    const again = store()
    await again.load()
    expect(again.activeOf('claude')).toBe('work')
    await expect(again.activate('claude', 'nope')).rejects.toMatchObject({ reason: 'account-unknown' })
  })

  it('moves an agent off a spent account to the one with the most room, and only once', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', null)
    await accounts.add('claude', null)
    // Signed in, as a finished sign-in would find them.
    for (const id of ['work', 'spare']) writeFileSync(path.join(root, 'agent-accounts', 'claude', id, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }))
    exits.splice(0).forEach((exit) => exit())
    await vi.waitFor(() => expect(touched).toHaveLength(2))
    const readings = [usage('default', 100), usage('work', 70), usage('spare', 20)]
    expect(accounts.switchFrom('claude', 'default', readings, NOW)).toBe('spare')
    expect(accounts.activeOf('claude')).toBe('spare')
    // Another conversation hitting the same limit finds the agent moved already.
    expect(accounts.switchFrom('claude', 'default', readings, NOW)).toBe('spare')
    await accounts.setAutoSwitch(false)
    expect(accounts.switchFrom('claude', 'spare', [...readings, usage('spare', 100)], NOW)).toBeNull()
  })

  it('removes an account, its links and folder, never what they lead to, and falls back to the user’s own', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', null)
    await accounts.activate('claude', 'work')
    writeFileSync(path.join(own, 'projects', 'kept.jsonl'), '{}')
    await accounts.remove('claude', 'work')
    expect(existsSync(path.join(root, 'agent-accounts', 'claude', 'work'))).toBe(false)
    expect(existsSync(path.join(own, 'projects', 'kept.jsonl'))).toBe(true)
    expect(accounts.activeOf('claude')).toBe('default')
    expect(touched.at(-1)).toEqual(['claude', 'work', true])
    await expect(accounts.remove('claude', 'default')).rejects.toMatchObject({ reason: 'account-default' })
  })
})
