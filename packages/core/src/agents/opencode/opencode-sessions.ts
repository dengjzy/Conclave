import { stat, realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { NativeSessions, NativeSession } from '../../native-session'
import { Rejection } from '../../rejection'

const ID = /^ses_[a-zA-Z0-9_-]+$/
const Row = z.object({ id: z.string(), directory: z.string() })

function sessionTable(db: DatabaseSync): 'session_v2' | 'session' {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get()) return 'session_v2'
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session'").get()) return 'session'
  throw new Rejection('native-session-storage-unsupported', '无法识别 OpenCode 会话数据库格式')
}

function databasePath(): string {
  const data = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode')
  const configured = process.env.OPENCODE_DB
  return configured ? path.resolve(data, configured) : path.join(data, 'opencode.db')
}

export function opencodeSessions(database = databasePath): NativeSessions {
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? database()) }),
    resolve: async ({ providerSessionId: id, cwd, home }) => {
      if (!ID.test(id)) throw new Rejection('native-session-id-invalid', 'OpenCode 会话标识无效')
      const file = path.resolve(home ?? database())
      const root = await realpath(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return file; throw error })
      return { id, root, locator: id, cwd }
    },
    children: async (session) => {
      if (!ID.test(session.id) || session.locator !== session.id) throw new Rejection('native-session-id-invalid')
      const info = await stat(session.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (!info) return []
      const db = new DatabaseSync(session.root, { readOnly: true })
      try {
        const table = sessionTable(db)
        const rows = db.prepare(table === 'session_v2' ? 'SELECT id, directory FROM session_v2 WHERE parent_id = ?' : 'SELECT id, directory FROM session WHERE parent_id = ?').all(session.id)
        return rows.map((raw): NativeSession => {
          const row = Row.parse(raw)
          if (!ID.test(row.id)) throw new Rejection('native-session-id-invalid')
          return { id: row.id, root: session.root, locator: row.id, cwd: row.directory }
        })
      } finally { db.close() }
    },
    remove: async (session, executor) => {
      if (!ID.test(session.id) || session.locator !== session.id) throw new Rejection('native-session-id-invalid')
      await executor.acp({ command: 'opencode', args: ['acp'], env: { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DB: session.root } }, session.cwd, 'session/delete', { sessionId: session.id })
      const info = await stat(session.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (!info) return
      const db = new DatabaseSync(session.root, { readOnly: true })
      try {
        const table = sessionTable(db)
        const remaining = db.prepare(table === 'session_v2' ? 'SELECT 1 FROM session_v2 WHERE id = ?' : 'SELECT 1 FROM session WHERE id = ?').get(session.id)
        if (remaining) throw new Rejection('native-session-delete-incomplete', 'OpenCode 原生会话仍在，清理尚未完成')
      } finally { db.close() }
    }
  }
}
