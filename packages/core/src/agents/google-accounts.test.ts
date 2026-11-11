import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountsSupported } from '@conclave/protocol'
import { AgentAccountStore } from '../agent-accounts'
import { antigravity } from './antigravity/antigravity-adapter'
import { antigravityAccounts } from './antigravity/antigravity-account'
import { gemini } from './gemini/gemini-adapter'
import { geminiAccounts } from './gemini/gemini-account'
import { readGeminiUsage } from './gemini/gemini-usage'
import { readAntigravityUsage } from './antigravity/antigravity-usage'

let root: string
let own: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'conclave-google-accounts-'))
  own = path.join(root, 'own')
  vi.stubEnv('GEMINI_HOME', own)
  vi.stubEnv('GEMINI_CLI_HOME', path.join(root, 'own-gemini'))
  vi.stubEnv('GEMINI_API_KEY', 'inherited-key')
  vi.stubEnv('GOOGLE_API_KEY', 'inherited-key')
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/other-account.json')
  await mkdir(path.join(own, 'antigravity-acp'), { recursive: true })
  await mkdir(path.join(process.env.GEMINI_CLI_HOME!, '.gemini'), { recursive: true })
})
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('Google accounts', () => {
  it.each([gemini, antigravity])('keeps two $kind logins separate from the default and sends the selected home to the agent', async (adapter) => {
    expect(accountsSupported(adapter.kind)).toBe(true)
    const support = adapter.accounts!
    const a = path.join(root, 'a'); const b = path.join(root, 'b')
    const relative = adapter.kind === 'gemini' ? '.gemini/oauth_creds.json' : 'antigravity-acp/acp_token.json'
    const ownFile = adapter.kind === 'gemini' ? path.join(process.env.GEMINI_CLI_HOME!, relative) : path.join(own, relative)
    await writeFile(ownFile, '{"default":true}')
    await support.prepare(a); await support.prepare(b)
    expect(await adapter.signedIn!(a)).toBe(false)
    expect(await adapter.signedIn!(b)).toBe(false)
    await writeFile(path.join(a, relative), '{"account":"a"}')
    expect(await adapter.signedIn!(a)).toBe(true)
    expect(await adapter.signedIn!(b)).toBe(false)
    await writeFile(path.join(b, relative), '{"account":"b"}')
    const command = adapter.command({ providerSessionId: null, resume: false, handoffPath: null, extraProjects: [], account: { id: 'b', env: support.env(b) } })
    expect(command.env).toMatchObject(support.env(b))
    await support.logoutAccount!(a)
    await rm(a, { recursive: true, force: true })
    expect(await readFile(path.join(b, relative), 'utf8')).toBe('{"account":"b"}')
    expect(await readFile(ownFile, 'utf8')).toBe('{"default":true}')
  })

  it('copies Gemini settings without selecting the default API key or sharing Google identities', async () => {
    const directory = path.join(process.env.GEMINI_CLI_HOME!, '.gemini')
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'vertex-ai', enforcedType: 'vertex-ai' } }, mcpServers: { example: { command: 'node' } } }))
    await writeFile(path.join(directory, 'google_accounts.json'), '{"active":"default@example.test"}')
    const a = path.join(root, 'a')
    await geminiAccounts.prepare(a)
    const settings = JSON.parse(await readFile(path.join(a, '.gemini/settings.json'), 'utf8'))
    expect(settings).toMatchObject({ security: { auth: { selectedType: 'oauth-personal' } }, mcpServers: { example: { command: 'node' } } })
    expect(settings.security.auth.enforcedType).toBeUndefined()
    expect(geminiAccounts.env(a)).toMatchObject({ GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GOOGLE_APPLICATION_CREDENTIALS: '', GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' })
    expect(await geminiAccounts.identity(a)).toEqual({ email: null })
    await writeFile(path.join(a, '.gemini/google_accounts.json'), '{"active":"a@example.test"}')
    expect(await geminiAccounts.identity(a)).toEqual({ email: 'a@example.test' })
    expect(await geminiAccounts.identity(undefined)).toEqual({ email: 'default@example.test' })
  })

  it('keeps Antigravity native session history available when an account is removed', async () => {
    const a = path.join(root, 'a'); const b = path.join(root, 'b')
    await antigravityAccounts.prepare(a); await antigravityAccounts.prepare(b)
    await writeFile(path.join(a, 'antigravity-acp/conversations/session.db'), 'history')
    await rm(a, { recursive: true, force: true })
    expect(await readFile(path.join(b, 'antigravity-acp/conversations/session.db'), 'utf8')).toBe('history')
    expect(await readFile(path.join(own, 'antigravity-acp/conversations/session.db'), 'utf8')).toBe('history')
  })

  it('reads Gemini quota with each account’s token rather than the default token', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push(new Headers(init.headers).get('authorization') ?? '')
      return Response.json(url.endsWith(':loadCodeAssist') ? { cloudaicompanionProject: 'project' } : { buckets: [{ remainingFraction: 0.5 }] })
    }))
    for (const name of ['a', 'b']) {
      const home = path.join(root, name)
      await geminiAccounts.prepare(home)
      await writeFile(path.join(home, '.gemini/oauth_creds.json'), JSON.stringify({ access_token: name, expiry_date: Date.now() + 3600000 }))
      expect(await readGeminiUsage(home)).toMatchObject({ signedIn: true, windows: [{ usedPercent: 50 }] })
    }
    expect(calls).toEqual(['Bearer a', 'Bearer a', 'Bearer b', 'Bearer b'])
  })

  it('reads Antigravity quota and refreshes tokens independently for each account', async () => {
    const authorizations: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/token')) return Response.json({ access_token: new URLSearchParams(String(init.body)).get('refresh_token'), expires_in: 3600 })
      authorizations.push(new Headers(init.headers).get('authorization') ?? '')
      return Response.json({ groups: [{ buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.25, window: '5h' }] }] })
    }))
    for (const name of ['a', 'b']) {
      const home = path.join(root, name)
      await antigravityAccounts.prepare(home)
      await writeFile(path.join(home, 'antigravity-acp/acp_token.json'), JSON.stringify({ client_id: 'public-client', client_secret: 'public-secret', refresh_token: `${root}-${name}`, project_id: name }))
      expect(await readAntigravityUsage(home)).toMatchObject({ signedIn: true, windows: [{ usedPercent: 75 }] })
    }
    expect(authorizations).toEqual([`Bearer ${root}-a`, `Bearer ${root}-b`])
  })

  it('uses the account login hook and refreshes callers when the active account changes', async () => {
    const login = vi.spyOn(geminiAccounts, 'loginCommand').mockResolvedValue({ command: process.execPath, args: ['login-entry.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } })
    const signIn = vi.fn(async () => ({ id: 'terminal' }))
    const changed = vi.fn()
    const store = new AgentAccountStore(path.join(root, 'accounts.json'), path.join(root, 'accounts'), {
      signIn: async (argv, env) => { await signIn(); expect(argv.command).toBe(process.execPath); expect(env).toMatchObject({ GEMINI_API_KEY: '', ELECTRON_RUN_AS_NODE: '1' }); return { id: 'terminal', sessionId: 'login', cwd: root, title: 'Google sign-in', createdAt: 0 } },
      waitForExit: () => new Promise(() => {}), accountChanged: changed, changed: () => {}, newId: () => 'a'
    })
    await store.load()
    await store.add('gemini', 'Work')
    expect(login).toHaveBeenCalledWith(path.join(root, 'accounts/gemini/a'))
    await store.activate('gemini', 'a')
    expect(changed).toHaveBeenCalledWith('gemini', 'a', false)
    expect(await store.launch('gemini')).toMatchObject({ id: 'a', env: { GEMINI_CLI_HOME: path.join(root, 'accounts/gemini/a') } })
    await store.remove('gemini', 'a')
    expect(store.activeOf('gemini')).toBe('default')
  })
})
