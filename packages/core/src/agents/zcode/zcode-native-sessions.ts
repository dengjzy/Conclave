import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import type { NativeSession, NativeSessions } from '../../native-session'
import { sessionStorageRoot, storedSessionExists } from '../../native-session-files'
import { zcodeSessionDb } from './zcode-transcripts'
import { removeZcodeSession } from './zcode-session-deletion'

const ID = /^(?:sess_)?[a-z0-9_-]+$/i

export function zcodeNativeSessions(database: () => string = zcodeSessionDb): NativeSessions {
  const record = (root: string, file: string, id: string, cwd: string): NativeSession => ({ id, root, locator: file, cwd })
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? database()) }),
    resolve: async (target) => {
      if (!ID.test(target.providerSessionId)) throw new Error('ZCode 会话标识无效')
      const file = target.home ?? database()
      if (!await storedSessionExists(file)) return null
      const canonical = await sessionStorageRoot(file)
      const root = path.dirname(canonical)
      const db = new DatabaseSync(canonical, { readOnly: true })
      try {
        const row = db.prepare('SELECT id FROM session WHERE id = ?').get(target.providerSessionId)
        return row ? record(root, canonical, target.providerSessionId, target.cwd) : null
      } finally { db.close() }
    },
    children: async (session) => {
      if (!await storedSessionExists(session.locator)) return []
      const db = new DatabaseSync(session.locator, { readOnly: true })
      try {
        // Only task-created children belong to the caller; interactive forks are independent.
        return db.prepare("SELECT id FROM session WHERE parent_id = ? AND task_type != 'interactive'").all(session.id).map((row) => {
          const id = String(row.id)
          if (!ID.test(id)) throw new Error('ZCode 子会话标识无效')
          return record(session.root, session.locator, id, session.cwd)
        })
      } finally { db.close() }
    },
    remove: async (session) => {
      if (!ID.test(session.id) || path.dirname(session.locator) !== session.root) throw new Error('ZCode 会话定位无效')
      if (await storedSessionExists(session.locator)) removeZcodeSession(session.locator, session.id)
    }
  }
}
