import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeSession, NativeSessionExecutor, NativeSessions } from '../../native-session'
import { claudeNativeSessions } from './claude-native-sessions'
import { codexNativeSessions } from '../codex/codex-native-sessions'
import { dshNativeSessions } from '../dsh/dsh-native-sessions'
import { piNativeSessions } from '../pi/pi-native-sessions'
import { antigravityNativeSessions } from '../antigravity/antigravity-native-sessions'
import { zcodeNativeSessions } from '../zcode/zcode-native-sessions'
import { zcodeTranscripts } from '../zcode/zcode-transcripts'

const MAIN = '11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'
const FORK = '33333333-3333-4333-8333-333333333333'
const executor: NativeSessionExecutor = {
  command: async () => { throw new Error('cleanup unexpectedly launched a CLI') },
  acp: async () => { throw new Error('cleanup unexpectedly launched ACP') }
}
let root: string
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}
const resolve = async (support: NativeSessions, id: string): Promise<NativeSession> => {
  const ref = await support.resolve({ providerSessionId: id, cwd: '/project' })
  if (!ref) throw new Error('session missing from fixture')
  return ref
}

beforeEach(() => { root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conclave-native-cleanup-'))) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('native history cleanup', () => {
  it.each(['claude', 'codex', 'pi', 'dsh', 'antigravity', 'zcode'])('captures %s storage before a record exists and ignores later default-home changes', async (agent) => {
    const original = path.join(root, 'original')
    let current = original
    const options = {
      claude: () => claudeNativeSessions(() => current),
      codex: () => codexNativeSessions(() => current),
      pi: () => piNativeSessions(() => path.join(current, 'sessions')),
      dsh: () => dshNativeSessions(() => current),
      antigravity: () => antigravityNativeSessions(() => path.join(current, 'brain')),
      zcode: () => zcodeNativeSessions(() => path.join(current, 'db.sqlite'))
    }
    const factory = Object.entries(options).find(([name]) => name === agent)?.[1]
    if (!factory) throw new Error('missing native fixture factory')
    const support = factory()
    const target = support.capture?.({ providerSessionId: MAIN, cwd: '/project' })
    if (!target) throw new Error('missing storage capture')
    expect(await support.resolve(target)).toBeNull()
    current = path.join(root, 'replacement')
    if (agent === 'claude') write(path.join(original, 'projects', '-project', `${MAIN}.jsonl`), '{}')
    else if (agent === 'codex') write(path.join(original, 'sessions', '2026', '11', '06', `rollout-${MAIN}.jsonl`), { type: 'session_meta', payload: { id: MAIN } })
    else if (agent === 'pi') write(path.join(original, 'sessions', '-project', `2026_${MAIN}.jsonl`), { type: 'session', id: MAIN })
    else if (agent === 'dsh') {
      const file = path.join(original, 'sessions', '--project--', MAIN, 'session.v4.jsonl.zstd')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: MAIN })}\n`)))
    } else if (agent === 'antigravity') write(path.join(original, 'brain', MAIN, '.system_generated', 'logs', 'transcript.jsonl'), 'log')
    else {
      mkdirSync(original, { recursive: true })
      const db = new DatabaseSync(path.join(original, 'db.sqlite'))
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
      db.prepare('INSERT INTO session VALUES (?)').run(MAIN)
      db.close()
    }
    const recovered = await support.resolve(target)
    expect(recovered?.root.startsWith(original)).toBe(true)
    expect(await support.resolve({ providerSessionId: MAIN, cwd: '/project' })).toBeNull()
  })

  it('finds empty Conclave Claude histories and removes their contained subagent logs only', async () => {
    const support = claudeNativeSessions(() => root)
    const file = path.join(root, 'projects', '-project', `${MAIN}.jsonl`)
    write(file, { type: 'system', sessionId: MAIN })
    write(path.join(root, 'projects', '-project', MAIN, 'subagents', 'agent-a.jsonl'), 'child')
    write(path.join(root, 'projects', '-project', `${FORK}.jsonl`), 'independent fork')
    const index = path.join(path.dirname(file), 'sessions-index.json')
    write(index, { version: 1, entries: [{ sessionId: MAIN }, { sessionId: FORK }] })
    const ref = await resolve(support, MAIN)
    await support.remove(ref, executor)
    await support.remove(ref, executor)
    expect(existsSync(file)).toBe(false)
    expect(JSON.parse(readFileSync(index, 'utf8')).entries).toEqual([{ sessionId: FORK }])
    expect(existsSync(path.join(path.dirname(file), MAIN))).toBe(false)
    expect(existsSync(path.join(path.dirname(file), `${FORK}.jsonl`))).toBe(true)
  })

  it('normalizes shared Claude account history roots', async () => {
    const shared = path.join(root, 'shared')
    const account = path.join(root, 'account')
    write(path.join(shared, 'projects', '-project', `${MAIN}.jsonl`), '{}')
    mkdirSync(account)
    symlinkSync(path.join(shared, 'projects'), path.join(account, 'projects'), process.platform === 'win32' ? 'junction' : 'dir')
    const first = await resolve(claudeNativeSessions(() => shared), MAIN)
    const second = await resolve(claudeNativeSessions(() => account), MAIN)
    expect(second.root).toBe(first.root)
  })

  it('deletes a Pi sessionFile without following ordinary fork parentSession links', async () => {
    const dir = path.join(root, 'sessions')
    const file = path.join(dir, '-project', `2026_${MAIN}.jsonl`)
    write(file, { type: 'session', id: MAIN, cwd: '/project' })
    write(path.join(dir, '-project', `2026_${FORK}.jsonl`), { type: 'session', id: FORK, parentSession: file })
    const support = piNativeSessions(() => dir)
    const ref = await resolve(support, file)
    expect(ref.id).toBe(MAIN)
    expect(await support.children(ref)).toEqual([])
    await support.remove(ref, executor)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(path.join(dir, '-project', `2026_${FORK}.jsonl`))).toBe(true)
    await expect(resolve(support, path.join(root, 'outside.jsonl'))).rejects.toThrow('历史目录')
  })

  it('enumerates DSH subagents while retaining ordinary forks and clears projection cache', async () => {
    const support = dshNativeSessions(() => root)
    const session = (id: string, extra: object = {}) => {
      const file = path.join(root, 'sessions', '--project--', id, 'session.v4.jsonl.zstd')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id, cwd: '/project', ...extra })}\n`)))
      write(path.join(root, 'storages', 'session_projcache', 'sessions', `${id}.json`), '{}')
      return file
    }
    const file = session(MAIN)
    const child = session(CHILD, { parentSession: MAIN, origin: 'subagent' })
    const fork = session(FORK, { parentSession: MAIN })
    const ref = await resolve(support, MAIN)
    expect((await support.children(ref)).map((entry) => entry.id)).toEqual([CHILD])
    await support.remove(ref, executor)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(path.join(root, 'storages', 'session_projcache', 'sessions', `${MAIN}.json`))).toBe(false)
    expect(existsSync(child)).toBe(true)
    expect(existsSync(fork)).toBe(true)
  })

  it('refuses a linked DSH session directory outside its registered home', async () => {
    const outside = path.join(root, 'outside')
    const home = path.join(root, 'dsh')
    const file = path.join(outside, 'session.v4.jsonl.zstd')
    mkdirSync(outside)
    writeFileSync(file, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: MAIN })}\n`)))
    mkdirSync(path.join(home, 'sessions', '--project--'), { recursive: true })
    symlinkSync(outside, path.join(home, 'sessions', '--project--', MAIN), process.platform === 'win32' ? 'junction' : 'dir')
    const support = dshNativeSessions(() => home)
    await expect(support.resolve({ providerSessionId: MAIN, cwd: '/project' })).rejects.toThrow('历史目录')
    expect(existsSync(file)).toBe(true)
  })

  it('uses the real Codex spawn-edge schema and preserves an independent fork', async () => {
    const file = (id: string) => path.join(root, 'sessions', '2026', '11', '06', `rollout-2026-${id}.jsonl`)
    for (const id of [MAIN, CHILD, FORK]) write(file(id), { type: 'session_meta', payload: { id, cwd: '/project', source: id === CHILD ? { subagent: {} } : 'cli', originator: 'conclave' } })
    write(path.join(root, 'session_index.jsonl'), [MAIN, CHILD, FORK].map((id) => JSON.stringify({ id })).join('\n'))
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT); CREATE TABLE thread_attachments (thread_id TEXT); CREATE TABLE thread_read_receipts (thread_id TEXT);')
    for (const id of [MAIN, CHILD, FORK]) db.prepare('INSERT INTO threads VALUES (?, ?)').run(id, file(id))
    db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(MAIN, CHILD, 'completed')
    db.prepare('INSERT INTO thread_attachments VALUES (?)').run(MAIN)
    db.prepare('INSERT INTO thread_read_receipts VALUES (?)').run(MAIN)
    const support = codexNativeSessions(() => root)
    const ref = await resolve(support, MAIN)
    expect((await support.children(ref)).map((entry) => entry.id)).toEqual([CHILD])
    await support.remove(ref, executor)
    expect(db.prepare('SELECT * FROM threads WHERE id = ?').get(MAIN)).toBeUndefined()
    expect(db.prepare('SELECT * FROM thread_attachments').all()).toEqual([])
    expect(db.prepare('SELECT * FROM thread_read_receipts').all()).toEqual([])
    expect(existsSync(file(CHILD))).toBe(true)
    expect(existsSync(file(FORK))).toBe(true)
    expect(readFileSync(path.join(root, 'session_index.jsonl'), 'utf8')).not.toContain(MAIN)
    db.close()
  })

  it('discovers archived Codex subagent headers when no spawn-edge database exists', async () => {
    const support = codexNativeSessions(() => root)
    write(path.join(root, 'sessions', '2026', '11', '06', `rollout-${MAIN}.jsonl`), { type: 'session_meta', payload: { id: MAIN } })
    const child = path.join(root, 'archived_sessions', `${CHILD}.jsonl`)
    write(child, { type: 'session_meta', payload: { id: CHILD, source: { subagent: { thread_spawn: { parent_thread_id: MAIN } } } } })
    write(path.join(root, 'archived_sessions', `${FORK}.jsonl`), { type: 'session_meta', payload: { id: FORK, source: 'cli', forked_from: MAIN } })
    const parent = await resolve(support, MAIN)
    const children = await support.children(parent)
    expect(children.map((entry) => entry.id)).toEqual([CHILD])
    await support.remove(children[0]!, executor)
    expect(existsSync(child)).toBe(false)
    expect(existsSync(path.join(root, 'archived_sessions', `${FORK}.jsonl`))).toBe(true)
  })

  it('normalizes Codex account sessions linked to shared history', async () => {
    const shared = path.join(root, 'shared')
    const account = path.join(root, 'account')
    write(path.join(shared, 'sessions', '2026', '11', '06', `rollout-${MAIN}.jsonl`), { type: 'session_meta', payload: { id: MAIN } })
    mkdirSync(account)
    symlinkSync(path.join(shared, 'sessions'), path.join(account, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir')
    const support = codexNativeSessions(() => shared)
    const first = await resolve(support, MAIN)
    const second = await support.resolve({ providerSessionId: MAIN, cwd: '/project', home: account })
    expect(second?.root).toBe(first.root)
  })

  it('cleans Codex history linked to a differently named directory without moving its metadata scope', async () => {
    const home = path.join(root, 'codex')
    const storage = path.join(root, 'custom-history')
    const account = path.join(root, 'account')
    mkdirSync(home)
    mkdirSync(account)
    const file = path.join(storage, '2026', '11', '06', `rollout-${MAIN}.jsonl`)
    write(file, { type: 'session_meta', payload: { id: MAIN } })
    symlinkSync(storage, path.join(home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(storage, path.join(account, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir')
    const dbFile = path.join(home, 'state_5.sqlite')
    const db = new DatabaseSync(dbFile)
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(MAIN, file)
    write(path.join(home, 'session_index.jsonl'), `${JSON.stringify({ id: MAIN })}\n`)
    if (process.platform !== 'win32') {
      symlinkSync(dbFile, path.join(account, 'state_5.sqlite'))
      symlinkSync(path.join(home, 'session_index.jsonl'), path.join(account, 'session_index.jsonl'))
    }
    const support = codexNativeSessions(() => home)
    const ref = await support.resolve({ providerSessionId: MAIN, cwd: '/project', home: process.platform === 'win32' ? home : account })
    if (!ref) throw new Error('linked history missing')
    expect(ref.root).toBe(storage)
    await support.remove(ref, executor)
    expect(existsSync(file)).toBe(false)
    expect(db.prepare('SELECT * FROM threads').all()).toEqual([])
    expect(readFileSync(path.join(home, 'session_index.jsonl'), 'utf8')).toBe('')
    db.close()
  })

  it('enumerates Antigravity children and deletes matching database/index data', async () => {
    const brain = path.join(root, 'brain')
    for (const id of [MAIN, CHILD, FORK]) write(path.join(brain, id, '.system_generated', 'logs', 'transcript.jsonl'), 'log')
    write(path.join(root, 'conversations', `${MAIN}.db`), 'db')
    const db = new DatabaseSync(path.join(root, 'conversation_summaries.db'))
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT); CREATE TABLE conversations_fts (conversation_id TEXT);')
    for (const id of [MAIN, CHILD, FORK]) db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(id, id === CHILD ? MAIN : null)
    db.prepare('INSERT INTO conversations_fts VALUES (?)').run(MAIN)
    const support = antigravityNativeSessions(() => brain)
    const ref = await resolve(support, MAIN)
    expect((await support.children(ref)).map((entry) => entry.id)).toEqual([CHILD])
    await support.remove(ref, executor)
    expect(existsSync(path.join(brain, MAIN))).toBe(false)
    expect(existsSync(path.join(root, 'conversations', `${MAIN}.db`))).toBe(false)
    expect(db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(MAIN)).toBeUndefined()
    expect(db.prepare('SELECT * FROM conversations_fts').all()).toEqual([])
    expect(existsSync(path.join(brain, CHILD))).toBe(true)
    db.close()
  })

  it('deletes real ZCode session/message/part tables and distinguishes task children from forks', async () => {
    const file = path.join(root, 'db.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, task_type TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT);')
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run(MAIN, null, 'interactive')
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run(CHILD, MAIN, 'subagent')
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run(FORK, MAIN, 'interactive')
    db.prepare('INSERT INTO message VALUES (?, ?)').run('m', MAIN)
    db.prepare('INSERT INTO part VALUES (?, ?)').run('p', MAIN)
    const support = zcodeNativeSessions(() => file)
    const ref = await resolve(support, MAIN)
    expect((await support.children(ref)).map((entry) => entry.id)).toEqual([CHILD])
    await zcodeTranscripts(() => file).delete?.(`${file}#${MAIN}`)
    expect(db.prepare('SELECT * FROM session WHERE id = ?').get(MAIN)).toBeUndefined()
    expect(db.prepare('SELECT * FROM message').all()).toEqual([])
    expect(db.prepare('SELECT * FROM part').all()).toEqual([])
    expect(db.prepare('SELECT * FROM session WHERE id = ?').get(FORK)).toBeDefined()
    db.close()
  })
})
