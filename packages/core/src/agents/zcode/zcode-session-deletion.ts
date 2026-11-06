import { DatabaseSync } from 'node:sqlite'

export function removeZcodeSession(file: string, id: string): void {
  const db = new DatabaseSync(file)
  let transaction = false
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
    transaction = true
    db.prepare('DELETE FROM part WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM message WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM session WHERE id = ?').run(id)
    db.exec('COMMIT')
    transaction = false
  } catch (error) {
    if (transaction) db.exec('ROLLBACK')
    throw error
  } finally { db.close() }
}
