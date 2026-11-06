import { readdir, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { z } from 'zod'
import type { NativeSession, NativeSessions } from '../../native-session'
import { missingSessionFile, sessionStorageFiles, sessionStorageRoot, storedSessionHeader, storedSessionPath } from '../../native-session-files'
import { codexDefaultHome } from './codex-account'
import { pruneCodexDatabases, pruneCodexSessionIndex } from './codex-transcripts'

const Spawned = z.looseObject({ id: z.string(), source: z.looseObject({ subagent: z.looseObject({ thread_spawn: z.looseObject({ parent_thread_id: z.string() }) }) }) })
const Locator = z.object({ file: z.string(), home: z.string(), archive: z.string() })
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Scope = { root: string; home: string; archive: string }

async function stateDatabases(home: string): Promise<string[]> {
  try { return (await readdir(home)).filter((name) => /^state_\d+\.sqlite$/.test(name)).map((name) => path.join(home, name)) } catch (error) {
    if (missingSessionFile(error)) return []
    throw error
  }
}

function record(scope: Scope, id: string, file: string, cwd: string): NativeSession {
  return { id, root: scope.root, locator: JSON.stringify({ file, home: scope.home, archive: scope.archive }), cwd }
}

async function locatedFile(scope: Scope, file: string): Promise<string | null> {
  const boundary = file.startsWith(`${scope.archive}${path.sep}`) ? scope.archive : scope.root
  return storedSessionPath(boundary, file)
}

async function validateHeader(file: string, id: string): Promise<void> {
  if (!/\.jsonl(?:\.zst)?$/.test(file)) throw new Error('Codex 会话文件格式无效')
  const payload = (await storedSessionHeader(file, 'session_meta'))?.payload
  if (!payload || typeof payload !== 'object' || !('id' in payload) || payload.id !== id) throw new Error('Codex 会话文件标识不匹配')
}

export function codexNativeSessions(home: () => string = codexDefaultHome): NativeSessions {
  const locate = async (scope: Scope, id: string, cwd: string): Promise<NativeSession | null> => {
    let indexed = false
    for (const file of await stateDatabases(scope.home)) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'threads'").get()) continue
        const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((row) => String(row.name)))
        const row = db.prepare(`SELECT id${columns.has('rollout_path') ? ', rollout_path' : ''} FROM threads WHERE id = ?`).get(id)
        if (!row) continue
        indexed = true
        if (typeof row.rollout_path === 'string' && row.rollout_path) {
          const raw = path.isAbsolute(row.rollout_path) ? row.rollout_path : path.join(scope.home, row.rollout_path)
          const candidate = await sessionStorageRoot(raw)
          const locator = await locatedFile(scope, candidate)
          if (locator) { await validateHeader(locator, id); return record(scope, id, locator, cwd) }
        }
      } finally { db.close() }
    }
    const candidates = [
      ...await sessionStorageFiles(scope.root, 3, (name) => name.endsWith(`-${id}.jsonl`) || name.endsWith(`-${id}.jsonl.zst`)),
      ...await sessionStorageFiles(scope.archive, 3, (name) => name.endsWith(`-${id}.jsonl`) || name.endsWith(`-${id}.jsonl.zst`) || name === `${id}.jsonl`)
    ]
    for (const candidate of candidates) {
      const locator = await locatedFile(scope, candidate)
      if (!locator) continue
      await validateHeader(locator, id)
      return record(scope, id, locator, cwd)
    }
    return indexed ? record(scope, id, path.join(scope.root, `${id}.jsonl`), cwd) : null
  }
  const scopeOf = (session: NativeSession) => {
    const locator = Locator.parse(JSON.parse(session.locator))
    return { ...locator, root: session.root }
  }
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? home()) }),
    resolve: async (target) => {
      if (!ID.test(target.providerSessionId)) throw new Error('Codex 会话标识无效')
      const selected = await sessionStorageRoot(target.home ?? home())
      const root = await sessionStorageRoot(path.join(selected, 'sessions'))
      const archive = await sessionStorageRoot(path.join(selected, 'archived_sessions'))
      return locate({ home: selected, root, archive }, target.providerSessionId, target.cwd)
    },
    children: async (session) => {
      const scope = scopeOf(session)
      const ids = new Set<string>()
      for (const file of await stateDatabases(scope.home)) {
        const db = new DatabaseSync(file, { readOnly: true })
        try {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_spawn_edges'").get()) continue
          const columns = new Set(db.prepare('PRAGMA table_info(thread_spawn_edges)').all().map((row) => String(row.name)))
          if (!columns.has('parent_thread_id') || !columns.has('child_thread_id')) continue
          for (const row of db.prepare('SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?').all(session.id)) ids.add(String(row.child_thread_id))
        } finally { db.close() }
      }
      // Older Codex versions keep the relation in the rollout header rather than SQLite.
      const logs = [
        ...await sessionStorageFiles(scope.root, 3, (name) => /^rollout-.+\.jsonl(?:\.zst)?$/.test(name)),
        ...await sessionStorageFiles(scope.archive, 3, (name) => /\.jsonl(?:\.zst)?$/.test(name))
      ]
      for (const file of logs) {
        const spawned = Spawned.safeParse((await storedSessionHeader(file, 'session_meta'))?.payload)
        if (spawned.success && spawned.data.source.subagent.thread_spawn.parent_thread_id === session.id) ids.add(spawned.data.id)
      }
      const children: NativeSession[] = []
      for (const id of ids) {
        if (!ID.test(id)) throw new Error('Codex 子会话标识无效')
        const found = await locate(scope, id, session.cwd)
        if (found) children.push(found)
      }
      return children
    },
    remove: async (session) => {
      if (!ID.test(session.id)) throw new Error('Codex 会话标识无效')
      const scope = scopeOf(session)
      if (await sessionStorageRoot(path.join(scope.home, 'sessions')) !== session.root) throw new Error('Codex 会话存储链接已改变')
      const file = await locatedFile(scope, scope.file)
      if (file) { await validateHeader(file, session.id); await rm(file, { force: true }) }
      const paired = await locatedFile(scope, scope.file.endsWith('.zst') ? scope.file.slice(0, -4) : `${scope.file}.zst`)
      if (paired) await rm(paired, { force: true })
      const archived = await storedSessionPath(scope.archive, path.join(scope.archive, `${session.id}.jsonl`))
      if (archived) await rm(archived, { force: true })
      await pruneCodexSessionIndex(scope.home, session.id)
      pruneCodexDatabases(scope.home, session.id)
    }
  }
}
