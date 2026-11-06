import { rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import type { NativeSession, NativeSessions } from '../../native-session'
import { sessionStorageRoot, storedSessionExists, storedSessionPath } from '../../native-session-files'
import { antigravityBrainRoot } from './antigravity-transcripts'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const tables = (db: DatabaseSync) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => String(row.name)))

export function antigravityNativeSessions(brain: () => string = antigravityBrainRoot): NativeSessions {
  const record = (root: string, id: string, cwd: string): NativeSession => ({ id, root, locator: path.join(root, 'brain', id), cwd })
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? path.dirname(brain())) }),
    resolve: async (target) => {
      if (!ID.test(target.providerSessionId)) throw new Error('Antigravity 会话标识无效')
      const root = await sessionStorageRoot(target.home ?? path.dirname(brain()))
      const session = record(root, target.providerSessionId, target.cwd)
      if (await storedSessionPath(root, session.locator) || await storedSessionExists(path.join(root, 'conversations', `${session.id}.db`))) return session
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
          return record(session.root, id, session.cwd)
        })
      } finally { db.close() }
    },
    remove: async (session) => {
      if (!ID.test(session.id) || session.locator !== path.join(session.root, 'brain', session.id)) throw new Error('Antigravity 会话定位无效')
      const directory = await storedSessionPath(session.root, session.locator)
      if (directory) await rm(directory, { recursive: true, force: true })
      for (const suffix of ['', '-wal', '-shm']) {
        const file = await storedSessionPath(session.root, path.join(session.root, 'conversations', `${session.id}.db${suffix}`))
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
