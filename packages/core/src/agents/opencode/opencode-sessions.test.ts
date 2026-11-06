import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { opencodeSessions } from './opencode-sessions'
import type { NativeSessionExecutor } from '../../native-session'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-opencode-sessions-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('OpenCode native cleanup', () => {
  it('captures the exact database filename instead of resolving the current environment later', async () => {
    let file = path.join(root, 'original.sqlite')
    const source = opencodeSessions(() => file)
    const captured = source.capture?.({ providerSessionId: 'ses_native', cwd: '/project' })
    if (!captured) throw new Error('missing capture')
    file = path.join(root, 'changed.sqlite')
    expect((await source.resolve(captured))?.root).toBe(path.join(root, 'original.sqlite'))
  })

  it.each(['session_v2', 'session'] as const)('enumerates %s child relationships and deletes through native ACP without session creation', async (table) => {
    const file = path.join(root, 'opencode.db'), db = new DatabaseSync(file)
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT); INSERT INTO ${table} VALUES('ses_parent',NULL,'/project'),('ses_child','ses_parent','/project'),('ses_other',NULL,'/project')`)
    db.close()
    const source = opencodeSessions(() => file)
    const session = await source.resolve({ providerSessionId: 'ses_parent', cwd: '/project' })
    if (!session) throw new Error('missing session')
    expect((await source.children(session)).map((child) => child.id)).toEqual(['ses_child'])
    const calls: unknown[] = []
    const executor: NativeSessionExecutor = { command: async () => '', acp: async (...args) => {
      calls.push(args)
      const db = new DatabaseSync(file)
      db.prepare(table === 'session_v2' ? 'DELETE FROM session_v2 WHERE id = ? OR parent_id = ?' : 'DELETE FROM session WHERE id = ? OR parent_id = ?').run('ses_parent', 'ses_parent')
      db.close()
      return {}
    } }
    await source.remove(session, executor)
    expect(calls).toEqual([[expect.objectContaining({ command: 'opencode', args: ['acp'], env: expect.objectContaining({ OPENCODE_DB: file }) }), '/project', 'session/delete', { sessionId: 'ses_parent' }]])
  })
  it('does not claim success if the native API leaves the target record behind', async () => {
    const file = path.join(root, 'opencode.db'), db = new DatabaseSync(file)
    db.exec("CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT); INSERT INTO session_v2 VALUES('ses_parent',NULL,'/project')")
    db.close()
    const source = opencodeSessions(() => file)
    const session = await source.resolve({ providerSessionId: 'ses_parent', cwd: '/project' })
    if (!session) throw new Error('missing session')
    await expect(source.remove(session, { command: async () => '', acp: async () => ({}) })).rejects.toMatchObject({ reason: 'native-session-delete-incomplete' })
  })

})
