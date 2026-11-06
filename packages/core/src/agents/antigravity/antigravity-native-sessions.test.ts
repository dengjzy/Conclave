import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationDeletion } from '../../conversation-deletion'
import { ConversationStore } from '../../conversation-store'
import { TaskStore } from '../../task-store'
import { nativeSessionKey, type NativeSessionExecutor, type NativeSessions } from '../../native-session'
import { antigravityAccounts } from './antigravity-account'
import { antigravityNativeSessions } from './antigravity-native-sessions'

const MAIN = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const executor: NativeSessionExecutor = {
  command: async () => { throw new Error('cleanup unexpectedly launched a CLI') },
  acp: async () => { throw new Error('cleanup unexpectedly launched ACP') }
}
let root: string
let own: string
let ide: string
let support: NativeSessions

function write(file: string, content = 'history'): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function history(storage: string, id: string): void {
  write(path.join(storage, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'))
  for (const suffix of ['.db', '.db-wal', '.db-shm', '.meta']) write(path.join(storage, 'conversations', `${id}${suffix}`))
}

function capture(home?: string) {
  const target = support.capture?.({ providerSessionId: MAIN, cwd: '/project', home })
  if (!target) throw new Error('missing storage capture')
  return target
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conclave-antigravity-history-')))
  own = path.join(root, 'gemini')
  ide = path.join(root, 'ide', 'antigravity')
  vi.stubEnv('GEMINI_HOME', own)
  support = antigravityNativeSessions(undefined, () => path.join(ide, 'brain'))
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('Antigravity native storage', () => {
  it('captures the shared ACP root before a record exists and survives removing its account', async () => {
    const account = path.join(root, 'account')
    await antigravityAccounts.prepare(account)
    const target = capture(account)
    expect(target.home).toBe(path.join(own, 'antigravity-acp'))
    expect(await support.resolve(target)).toMatchObject({ root: target.home, artifacts: target.artifacts })
    rmSync(account, { recursive: true, force: true })
    vi.stubEnv('GEMINI_HOME', path.join(root, 'replacement'))
    history(path.join(own, 'antigravity-acp'), MAIN)
    expect(await support.resolve(target)).toMatchObject({ root: path.join(own, 'antigravity-acp'), id: MAIN })
    expect(await support.resolve({ providerSessionId: MAIN, cwd: '/project' })).toBeNull()
  })

  it('gives every account the same native identity and removes only the selected history', async () => {
    const a = path.join(root, 'a'), b = path.join(root, 'b')
    await antigravityAccounts.prepare(a); await antigravityAccounts.prepare(b)
    const storage = path.join(own, 'antigravity-acp')
    history(storage, MAIN); history(storage, OTHER)
    for (const home of [own, a, b]) write(path.join(home, 'antigravity-acp', 'acp_token.json'), home)
    const sessions = await Promise.all([undefined, a, b].map((home) => support.resolve({ providerSessionId: MAIN, cwd: '/project', home })))
    const first = sessions[0]
    if (!first) throw new Error('missing default session')
    expect(sessions.map((session) => session && nativeSessionKey('antigravity', session))).toEqual(sessions.map(() => nativeSessionKey('antigravity', first)))
    await support.remove(first, executor)
    for (const suffix of ['.db', '.db-wal', '.db-shm', '.meta']) expect(existsSync(path.join(storage, 'conversations', `${MAIN}${suffix}`))).toBe(false)
    expect(existsSync(path.join(storage, 'brain', MAIN))).toBe(false)
    expect(existsSync(path.join(b, 'antigravity-acp', 'conversations', `${OTHER}.db`))).toBe(true)
    for (const home of [own, a, b]) expect(readFileSync(path.join(home, 'antigravity-acp', 'acp_token.json'), 'utf8')).toBe(home)
  })

  it('recovers an exact shared session from an account removed before its storage was captured', async () => {
    const account = path.join(root, 'account')
    await antigravityAccounts.prepare(account)
    history(path.join(own, 'antigravity-acp'), MAIN)
    rmSync(account, { recursive: true, force: true })
    const target = capture(account)
    expect(target.home).toBe(path.join(own, 'antigravity-acp'))
    expect(await support.resolve(target)).toMatchObject({ root: path.join(own, 'antigravity-acp'), id: MAIN })
    expect(await support.resolve({ providerSessionId: OTHER, cwd: '/project', home: account })).toBeNull()
  })

  it('keeps imported IDE history separate and gives an existing ACP session priority', async () => {
    history(ide, MAIN)
    const imported = capture()
    expect(imported.home).toBe(ide)
    expect(await support.resolve(imported)).toMatchObject({ root: ide })
    const storage = path.join(own, 'antigravity-acp')
    history(storage, MAIN)
    const acp = await support.resolve({ providerSessionId: MAIN, cwd: '/project' })
    if (!acp) throw new Error('missing ACP session')
    expect(acp.root).toBe(storage)
    await support.remove(acp, executor)
    expect(existsSync(path.join(ide, 'brain', MAIN))).toBe(true)
    expect(await support.resolve(imported)).toMatchObject({ root: ide })
  })

  it('captures independent account artifacts separately from shared conversations', async () => {
    const account = path.join(root, 'account', 'antigravity-acp')
    const first = path.join(root, 'first'), second = path.join(root, 'second')
    history(first, MAIN); history(second, MAIN)
    mkdirSync(account, { recursive: true })
    mkdirSync(path.join(account, 'brain'))
    write(path.join(account, 'brain', MAIN, 'artifact.txt'))
    symlinkSync(path.join(second, 'conversations'), path.join(account, 'conversations'), process.platform === 'win32' ? 'junction' : 'dir')
    const target = capture(path.dirname(account))
    expect(target.home).toBe(second)
    expect(target.artifacts).toContainEqual({ root: path.join(account, 'brain'), locator: path.join(account, 'brain', MAIN) })
    expect(existsSync(path.join(first, 'brain', MAIN))).toBe(true)
    expect(existsSync(path.join(second, 'conversations', `${MAIN}.db`))).toBe(true)
  })

  it('defers shared history deletion until its last conversation on another account is removed', async () => {
    const a = path.join(root, 'a'), b = path.join(root, 'b')
    await antigravityAccounts.prepare(a); await antigravityAccounts.prepare(b)
    const firstTarget = capture(a), secondTarget = capture(b)
    const storage = path.join(own, 'antigravity-acp')
    history(storage, MAIN); history(storage, OTHER)
    const database = path.join(root, 'conclave.db')
    const tasks = new TaskStore(database), store = new ConversationStore(database)
    try {
      const first = store.create('antigravity', '/project', ['/project'])
      const second = store.create('antigravity', '/project', ['/project'])
      store.rememberNativeTarget(first.id, 'antigravity', MAIN, '/project', 'a', firstTarget.home, firstTarget.artifacts)
      store.rememberNativeTarget(second.id, 'antigravity', MAIN, '/project', 'b', secondTarget.home, secondTarget.artifacts)
      rmSync(a, { recursive: true, force: true })
      const deletion = new ConversationDeletion(store, {
        quiesce: async () => {}, removeStopped: async (id) => { store.delete(id) }, changed: () => {}
      }, path.join(root, 'sessions'))
      deletion.configure({ adapter: () => support, executor, home: (_agent, account) => account === 'a' ? a : b })
      await deletion.delete(first.id)
      expect(existsSync(path.join(storage, 'conversations', `${MAIN}.db`))).toBe(true)
      expect(store.deletions()).toHaveLength(1)
      await deletion.delete(second.id)
      expect(existsSync(path.join(storage, 'conversations', `${MAIN}.db`))).toBe(false)
      expect(existsSync(path.join(storage, 'conversations', `${OTHER}.db`))).toBe(true)
      expect(store.deletions()).toEqual([])
    } finally { store.close(); tasks.close() }
  })

  it('collects all account artifacts when the same conversation resumes on another account', async () => {
    const a = path.join(root, 'a'), b = path.join(root, 'b')
    await antigravityAccounts.prepare(a); await antigravityAccounts.prepare(b)
    history(path.join(own, 'antigravity-acp'), MAIN)
    for (const home of [a, b]) {
      write(path.join(home, 'antigravity-acp', 'brain', MAIN, 'output.txt'))
      write(path.join(home, 'antigravity-acp', 'brain', OTHER, 'unrelated.txt'))
      write(path.join(home, 'antigravity-acp', 'brain', `.restore-${MAIN}-interrupted`, 'partial.txt'))
      write(path.join(home, 'antigravity-acp', 'brain', `.restore-${OTHER}-unrelated`, 'partial.txt'))
    }
    const database = path.join(root, 'conclave.db')
    const tasks = new TaskStore(database), store = new ConversationStore(database)
    try {
      const conversation = store.create('antigravity', '/project', ['/project'])
      for (const home of [a, b]) {
        const target = capture(home)
        store.rememberNativeTarget(conversation.id, 'antigravity', MAIN, '/project', path.basename(home), target.home, target.artifacts)
        const native = await support.resolve(target)
        if (!native) throw new Error('missing explicit native session')
        store.rememberNativeSession(conversation.id, 'antigravity', MAIN, '/project', path.basename(home), native)
      }
      expect(store.nativeSessions([conversation.id])[0]?.session.artifacts).toHaveLength(3)
      const deletion = new ConversationDeletion(store, { quiesce: async () => {}, removeStopped: async (id) => { store.delete(id) }, changed: () => {} }, path.join(root, 'sessions'))
      deletion.configure({ adapter: () => support, executor, home: () => undefined })
      await deletion.delete(conversation.id)
      for (const home of [own, a, b]) expect(existsSync(path.join(home, 'antigravity-acp', 'brain', MAIN))).toBe(false)
      for (const home of [a, b]) expect(existsSync(path.join(home, 'antigravity-acp', 'brain', OTHER))).toBe(true)
      for (const home of [a, b]) {
        expect(existsSync(path.join(home, 'antigravity-acp', 'brain', `.restore-${MAIN}-interrupted`))).toBe(false)
        expect(existsSync(path.join(home, 'antigravity-acp', 'brain', `.restore-${OTHER}-unrelated`))).toBe(true)
      }
      expect(existsSync(path.join(own, 'antigravity-acp', 'conversations', `${MAIN}.db`))).toBe(false)
    } finally { store.close(); tasks.close() }
  })
})
