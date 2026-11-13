import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountsSupported } from '@conclave/protocol'
import { AgentAccountStore } from '../../agent-accounts'
import { antigravity } from './antigravity-adapter'
import { antigravityAccounts, antigravityLaunchArgs, prepareAntigravitySession } from './antigravity-account'
import * as runtime from './antigravity-runtime'
import { readAntigravityUsage } from './antigravity-usage'

let root: string
let own: string
const MAIN = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'conclave-antigravity-accounts-'))
  own = path.join(root, 'own')
  vi.stubEnv('GEMINI_HOME', own)
  await mkdir(path.join(own, 'antigravity-cli'), { recursive: true })
})
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('Antigravity accounts', () => {
  it('keeps MCP caches inside each account while sharing native conversations', async () => {
    const a = path.join(root, 'a'), b = path.join(root, 'b')
    await antigravityAccounts.prepare(a); await antigravityAccounts.prepare(b)
    const file = path.join(a, 'antigravity-cli', 'brain', MAIN, 'mcp', 'conclave', 'user_todo_list.json')
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '{}')
    expect((await lstat(path.join(a, 'antigravity-cli', 'brain'))).isSymbolicLink()).toBe(false)
    expect(path.relative(await realpath(a), await realpath(file)).startsWith('..')).toBe(false)
    expect(await realpath(path.join(a, 'antigravity-cli', 'conversations'))).toBe(await realpath(path.join(b, 'antigravity-cli', 'conversations')))
    await expect(readFile(path.join(b, 'antigravity-cli', 'brain', MAIN, 'mcp', 'conclave', 'user_todo_list.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces an old shared brain link without deleting or copying unrelated history', async () => {
    const account = path.join(root, 'account'), shared = path.join(own, 'antigravity-cli', 'brain')
    const legacyShared = path.join(own, 'antigravity-acp', 'brain')
    await mkdir(path.join(shared, MAIN), { recursive: true }); await mkdir(path.join(shared, OTHER))
    await mkdir(path.join(legacyShared, OTHER), { recursive: true })
    await writeFile(path.join(shared, MAIN, 'image.png'), 'original')
    await writeFile(path.join(shared, OTHER, 'unrelated.txt'), 'other')
    await mkdir(path.join(account, 'antigravity-cli'), { recursive: true })
    await mkdir(path.join(account, 'antigravity-acp'), { recursive: true })
    await symlink(shared, path.join(account, 'antigravity-cli', 'brain'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(legacyShared, path.join(account, 'antigravity-acp', 'brain'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await antigravityAccounts.needsIdlePreparation?.(account)).toBe(true)
    await antigravityAccounts.prepare(account)
    expect(await antigravityAccounts.needsIdlePreparation?.(account)).toBe(false)
    await expect(readFile(path.join(account, 'antigravity-cli', 'brain', OTHER, 'unrelated.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await prepareAntigravitySession(account, MAIN)
    expect(await readFile(path.join(account, 'antigravity-cli', 'brain', MAIN, 'image.png'), 'utf8')).toBe('original')
    expect(await readFile(path.join(shared, MAIN, 'image.png'), 'utf8')).toBe('original')
    expect(await readFile(path.join(shared, OTHER, 'unrelated.txt'), 'utf8')).toBe('other')
  })

  it('restores only explicit session artifacts across accounts without overwriting local files or following links', async () => {
    const a = path.join(root, 'a'), b = path.join(root, 'b')
    await antigravityAccounts.prepare(a); await antigravityAccounts.prepare(b)
    const source = path.join(a, 'antigravity-cli', 'brain'), into = path.join(b, 'antigravity-cli', 'brain', MAIN)
    await mkdir(path.join(source, MAIN), { recursive: true }); await mkdir(path.join(source, OTHER))
    await writeFile(path.join(source, MAIN, 'image.png'), 'from-a')
    await writeFile(path.join(source, OTHER, 'other.png'), 'unrelated')
    const secret = path.join(root, 'outside.txt'); await writeFile(secret, 'must-not-copy')
    if (process.platform !== 'win32') await symlink(secret, path.join(source, MAIN, 'external.txt'))
    const latest = path.join(root, 'latest', 'brain')
    await mkdir(path.join(latest, MAIN), { recursive: true }); await writeFile(path.join(latest, MAIN, 'image.png'), 'latest')
    await prepareAntigravitySession(b, MAIN, [{ root: latest, locator: path.join(latest, MAIN) }, { root: source, locator: path.join(source, MAIN) }])
    expect(await readFile(path.join(into, 'image.png'), 'utf8')).toBe('latest')
    await expect(readFile(path.join(into, 'external.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(b, 'antigravity-cli', 'brain', OTHER, 'other.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(path.join(into, 'image.png'), 'current-b')
    await prepareAntigravitySession(b, MAIN, [{ root: source, locator: path.join(source, MAIN) }])
    expect(await readFile(path.join(into, 'image.png'), 'utf8')).toBe('current-b')
    expect(await readFile(path.join(source, MAIN, 'image.png'), 'utf8')).toBe('from-a')
  })

  it('keeps two logins separate from the default and sends the selected home to the agent', async () => {
    const adapter = antigravity
    expect(accountsSupported(adapter.kind)).toBe(true)
    const support = adapter.accounts!
    const a = path.join(root, 'a'); const b = path.join(root, 'b')
    const relative = 'antigravity-cli/antigravity-oauth-token'
    const ownFile = path.join(own, relative)
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

  it('keeps Antigravity native session history available when an account is removed', async () => {
    const a = path.join(root, 'a'); const b = path.join(root, 'b')
    await antigravityAccounts.prepare(a); await antigravityAccounts.prepare(b)
    await writeFile(path.join(a, 'antigravity-cli/conversations/session.db'), 'history')
    await rm(a, { recursive: true, force: true })
    expect(await readFile(path.join(b, 'antigravity-cli/conversations/session.db'), 'utf8')).toBe('history')
    expect(await readFile(path.join(own, 'antigravity-cli/conversations/session.db'), 'utf8')).toBe('history')
  })

  it('reads Antigravity quota and refreshes tokens independently for each account', async () => {
    vi.spyOn(runtime, 'antigravityCliVersion').mockResolvedValue('1.5.6')
    vi.spyOn(runtime, 'readAntigravityOAuthClients').mockResolvedValue([{ clientId: 'test-client', clientSecret: 'test-secret' }])
    const authorizations: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/token')) return Response.json({ access_token: new URLSearchParams(String(init.body)).get('refresh_token'), expires_in: 3600 })
      if (url.endsWith(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: `proj-${new Headers(init.headers).get('authorization')}`, paidTier: { name: 'Google AI Pro' } })
      authorizations.push(new Headers(init.headers).get('authorization') ?? '')
      return Response.json({ groups: [{ buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.25, window: '5h' }] }] })
    }))
    for (const name of ['a', 'b']) {
      const home = path.join(root, name)
      await antigravityAccounts.prepare(home)
      await writeFile(path.join(home, 'antigravity-cli/antigravity-oauth-token'), JSON.stringify({
        token: { refresh_token: `${root}-${name}`, expiry: '2020-01-01T00:00:00Z' },
        auth_method: 'consumer'
      }))
      expect(await readAntigravityUsage(home)).toMatchObject({ signedIn: true, plan: 'Google AI Pro', windows: [{ usedPercent: 75 }] })
    }
    expect(authorizations).toEqual([`Bearer ${root}-a`, `Bearer ${root}-b`])
  })

  it('uses the account login hook and refreshes callers when the active account changes', async () => {
    const login = vi.spyOn(antigravityAccounts, 'loginCommand').mockResolvedValue({ command: process.execPath, args: ['login-entry.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } })
    const signIn = vi.fn(async () => ({ id: 'terminal' }))
    const changed = vi.fn()
    let finishLogin: (() => void) | undefined
    const store = new AgentAccountStore(path.join(root, 'accounts.json'), path.join(root, 'accounts'), {
      signIn: async (argv, env) => { await signIn(); expect(argv.command).toBe(process.execPath); expect(env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' }); return { id: 'terminal', sessionId: 'login', cwd: root, title: 'Google sign-in', createdAt: 0 } },
      waitForExit: () => new Promise((resolve) => { finishLogin = () => resolve(0) }), accountChanged: changed, changed: () => {}, newId: () => 'a'
    })
    await store.load()
    await store.add('antigravity', 'Work')
    expect(login).toHaveBeenCalledWith(path.join(root, 'accounts/antigravity/a'))
    await store.activate('antigravity', 'a')
    expect(changed).toHaveBeenCalledWith('antigravity', 'a', false)
    await expect(store.launch('antigravity')).rejects.toMatchObject({ reason: 'account-credentials-active' })
    finishLogin?.()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(await store.launch('antigravity')).toMatchObject({ id: 'a', env: { GEMINI_HOME: path.join(root, 'accounts/antigravity/a') } })
    const home = path.join(root, 'accounts/antigravity/a/antigravity-cli')
    await writeFile(path.join(home, 'antigravity-oauth-token'), 'test-credential')
    await mkdir(path.join(home, '.conclave-login', 'dead-login'), { recursive: true })
    await writeFile(path.join(home, '.conclave-login', 'dead-login', 'test-token.json'), 'staged-test-credential')
    await mkdir(path.join(home, 'brain', MAIN)); await writeFile(path.join(home, 'brain', MAIN, 'image.png'), 'keep-artifact')
    await store.remove('antigravity', 'a')
    expect(store.activeOf('antigravity')).toBe('default')
    expect((await lstat(path.join(root, 'accounts/antigravity/a/antigravity-cli/brain'))).isDirectory()).toBe(true)
    expect(await readFile(path.join(home, 'brain', MAIN, 'image.png'), 'utf8')).toBe('keep-artifact')
    for (const name of ['antigravity-oauth-token', '.conclave-login']) await expect(lstat(path.join(home, name))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('isolates agy 1.5+ accounts with --gemini-dir, keyring bypass markers, and private antigravity-cli brains', async () => {
    vi.spyOn(runtime, 'requireAntigravity').mockResolvedValue('/usr/local/bin/agy')
    const a = path.join(root, 'cli-a'), b = path.join(root, 'cli-b')
    await antigravityAccounts.prepare(a)
    await antigravityAccounts.prepare(b)

    expect(antigravityLaunchArgs()).toEqual(['acp', '--stdio'])
    expect(antigravityLaunchArgs(own)).toEqual(['acp', '--stdio'])
    expect(antigravityLaunchArgs(a)).toEqual(['acp', '--stdio', '--gemini-dir', a])

    expect((await lstat(path.join(a, 'antigravity-cli', 'cache', 'antigravity-keyring-unavailable'))).isFile()).toBe(true)
    expect((await lstat(path.join(a, 'antigravity-cli', 'brain'))).isSymbolicLink()).toBe(false)
    expect(await realpath(path.join(a, 'antigravity-cli', 'conversations'))).toBe(await realpath(path.join(b, 'antigravity-cli', 'conversations')))

    // Default account's acp-auth-state.json does not mark secondary accounts as signed in.
    await mkdir(path.join(own, 'antigravity-cli', 'cache'), { recursive: true })
    await writeFile(path.join(own, 'antigravity-cli', 'cache', 'acp-auth-state.json'), '{"methodId":"oauth-personal"}')
    expect(await antigravity.signedIn!()).toBe(true)
    expect(await antigravity.signedIn!(a)).toBe(false)

    await writeFile(path.join(a, 'antigravity-cli', 'antigravity-oauth-token'), '{"access_token":"tok-a"}')
    expect(await antigravity.signedIn!(a)).toBe(true)
    expect(await antigravity.signedIn!(b)).toBe(false)

    const prepared = await antigravity.launch!.prepare(
      { sessionsRoot: root, conversationId: 'conv', stageId: 'stage', planOnly: false },
      undefined,
      { providerSessionId: null, resume: false, handoffPath: null, extraProjects: [], account: { id: 'a', env: antigravityAccounts.env(a) } }
    )
    expect(prepared).toEqual({ command: '/usr/local/bin/agy', args: ['acp', '--stdio', '--gemini-dir', a] })

    await antigravityAccounts.logoutAccount!(a)
    expect(await antigravity.signedIn!(a)).toBe(false)
    expect(await antigravity.signedIn!()).toBe(true)
  })
})
