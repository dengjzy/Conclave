import { readdir, rm } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import type { NativeArtifact, NativeSession, NativeSessions } from '../../native-session'
import { missingSessionFile, storedSessionExists, storedSessionPath } from '../../native-session-files'
import { antigravityBrainRoot } from './antigravity-transcripts'
import { antigravityTokenFile } from './antigravity-runtime'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const tables = (db: DatabaseSync) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => String(row.name)))

function hasSession(root: string, id: string): boolean {
  if (existsSync(path.join(root, 'brain', id)) || existsSync(path.join(root, 'conversations', `${id}.db`))) return true
  const file = path.join(root, 'conversation_summaries.db')
  if (!existsSync(file)) return false
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return tables(db).has('conversation_summaries') && Boolean(db.prepare('SELECT 1 FROM conversation_summaries WHERE conversation_id = ?').get(id))
  } finally { db.close() }
}

function realPath(file: string): string | null {
  try { return realpathSync(file) } catch (error) {
    if (missingSessionFile(error)) return null
    throw error
  }
}

function sharedRoot(root: string): string {
  const conversations = realPath(path.join(root, 'conversations'))
  if (!conversations) return realPath(root) ?? path.resolve(root)
  if (path.basename(conversations) !== 'conversations') throw new Error('Antigravity 会话存储目录无效')
  return path.dirname(conversations)
}

const acpBrainRoot = () => path.join(path.dirname(antigravityTokenFile()), 'brain')

export function antigravityNativeSessions(brain: () => string = acpBrainRoot, importedBrain: () => string = antigravityBrainRoot): NativeSessions {
  const artifact = (root: string, id: string): NativeArtifact => ({ root, locator: path.join(root, id) })
  const record = (root: string, id: string, cwd: string, artifacts: readonly NativeArtifact[]): NativeSession => ({ id, root, locator: path.join(root, 'conversations', `${id}.db`), cwd, artifacts: [...artifacts] })
  const storage = (id: string, home?: string): string => {
    if (!ID.test(id)) throw new Error('Antigravity 会话标识无效')
    const own = path.dirname(brain())
    // Captured homes name the durable storage root; launch homes name GEMINI_HOME.
    if (home) {
      if (home === own || hasSession(home, id)) return home
      if (!existsSync(home) && hasSession(own, id)) return own
      return path.join(home, 'antigravity-acp')
    }
    const imported = path.dirname(importedBrain())
    return hasSession(own, id) || !hasSession(imported, id) ? own : imported
  }
  const scope = (id: string, home?: string, captured?: readonly NativeArtifact[]) => {
    const local = storage(id, home)
    const root = sharedRoot(local)
    const localBrain = realPath(path.join(local, 'brain')) ?? path.resolve(local, 'brain')
    const artifacts = captured?.length ? [...captured] : [artifact(localBrain, id)]
    const legacyBrain = path.join(root, 'brain')
    if (existsSync(path.join(legacyBrain, id))) artifacts.push(artifact(realPath(legacyBrain) ?? legacyBrain, id))
    return { root, artifacts: [...new Map(artifacts.map((entry) => [JSON.stringify([entry.root, entry.locator]), entry])).values()] }
  }
  return {
    // Resolve shared links before an account folder can be removed or the default home changes.
    capture: (target) => {
      const saved = scope(target.providerSessionId, target.home, target.artifacts)
      return { ...target, home: saved.root, artifacts: saved.artifacts }
    },
    resolve: async (target) => {
      const { root, artifacts } = scope(target.providerSessionId, target.home, target.artifacts)
      const session = record(root, target.providerSessionId, target.cwd, artifacts)
      if (target.artifacts?.length || await storedSessionPath(root, session.locator)) return session
      for (const artifact of artifacts) if (await storedSessionPath(artifact.root, artifact.locator)) return session
      const file = path.join(root, 'conversation_summaries.db')
      if (!await storedSessionExists(file)) return null
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return tables(db).has('conversation_summaries') && db.prepare('SELECT 1 FROM conversation_summaries WHERE conversation_id = ?').get(session.id) ? session : null
      } finally { db.close() }
    },
    children: async (session) => {
      const file = path.join(session.root, 'conversation_summaries.db')
      if (!await storedSessionExists(file)) return []
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        if (!tables(db).has('conversation_summaries')) return []
        const columns = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map((row) => String(row.name)))
        if (!columns.has('parent_conversation_id')) return []
        return db.prepare('SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id = ?').all(session.id).map((row) => {
          const id = String(row.conversation_id)
          if (!ID.test(id)) throw new Error('Antigravity 子会话标识无效')
          return record(session.root, id, session.cwd, (session.artifacts ?? [{ root: path.join(session.root, 'brain'), locator: path.join(session.root, 'brain', session.id) }]).map((entry) => artifact(entry.root, id)))
        })
      } finally { db.close() }
    },
    remove: async (session) => {
      const legacy = path.join(session.root, 'brain', session.id)
      if (!ID.test(session.id) || ![legacy, path.join(session.root, 'conversations', `${session.id}.db`)].includes(session.locator)) throw new Error('Antigravity 会话定位无效')
      const artifacts = [...session.artifacts ?? [], ...(session.locator === legacy ? [{ root: path.dirname(legacy), locator: legacy }] : [])]
      for (const artifact of artifacts) {
        if (artifact.locator !== path.join(artifact.root, session.id)) throw new Error('Antigravity 产物定位无效')
        const directory = await storedSessionPath(artifact.root, artifact.locator)
        if (directory) await rm(directory, { recursive: true, force: true })
        const entries = await readdir(artifact.root).catch((error: unknown) => { if (missingSessionFile(error)) return []; throw error })
        for (const name of entries.filter((name) => name.startsWith(`.restore-${session.id}-`))) {
          const temporary = await storedSessionPath(artifact.root, path.join(artifact.root, name))
          if (temporary) await rm(temporary, { recursive: true, force: true })
        }
      }
      for (const name of [`${session.id}.db`, `${session.id}.db-wal`, `${session.id}.db-shm`, `${session.id}.meta`]) {
        const file = await storedSessionPath(session.root, path.join(session.root, 'conversations', name))
        if (file) await rm(file, { force: true })
      }
      const file = path.join(session.root, 'conversation_summaries.db')
      if (!await storedSessionExists(file)) return
      const db = new DatabaseSync(file)
      try {
        const available = tables(db)
        if (available.has('conversation_summaries')) db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(session.id)
        if (available.has('conversations_fts')) db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(session.id)
      } finally { db.close() }
    }
  }
}
