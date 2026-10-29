import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zcodeSessionDb, zcodeTranscripts } from './zcode-transcripts'

let dir: string
let file: string

// ZCode's tables as zcode-runtime 0.17.0 makes them, with only the columns read here.
function database(): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (id text primary key, parent_id text, directory text not null, title text not null, title_source text, time_created integer not null, time_updated integer not null, time_deleted integer, task_type text not null default 'interactive');
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer);
  `)
  return db
}

function session(db: DatabaseSync, id: string, extra: { parent?: string; title?: string; source?: string; deleted?: number; type?: string } = {}) {
  db.prepare('INSERT INTO session (id, parent_id, directory, title, title_source, time_created, time_updated, time_deleted, task_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, extra.parent ?? null, '/work/repo', extra.title ?? 'Fix the parser', extra.source ?? 'generated', 1000, 9000, extra.deleted ?? null, extra.type ?? 'interactive')
}

let seq = 0
function message(db: DatabaseSync, sessionId: string, id: string, at: number, data: object, parts: object[]) {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)').run(id, sessionId, at, at, JSON.stringify(data), seq++)
  parts.forEach((part, index) => db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${id}-p${index}`, id, sessionId, at, at, JSON.stringify(part), index))
}

const typed = (turnId: string) => ({ role: 'user', semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' }, anchor: { turnId, origin: 'realUser' } })
const reminder = (turnId: string) => ({ role: 'user', semantics: { origin: 'agent_runtime', kind: 'system_reminder', uiVisibility: 'hidden' }, anchor: { turnId } })
const answer = (turnId: string) => ({ role: 'assistant', semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible' }, anchor: { turnId } })

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-zcode-'))
  file = path.join(dir, 'db.sqlite')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ZCode sessions', () => {
  it('lists the sessions the user ran, newest first, with what was first typed', async () => {
    const db = database()
    session(db, 'sess_a', { title: '' })
    message(db, 'sess_a', 'm1', 1000, reminder('t1'), [{ type: 'text', text: 'Available agent types' }])
    message(db, 'sess_a', 'm2', 1001, typed('t1'), [{ type: 'text', text: 'Fix the parser\nit drops commas' }])
    session(db, 'sess_named', { title: 'My session', source: 'custom' })
    message(db, 'sess_named', 'm3', 1000, typed('t1'), [{ type: 'text', text: 'hi' }])
    session(db, 'sess_child', { parent: 'sess_a' })
    message(db, 'sess_child', 'm4', 1000, typed('t1'), [{ type: 'text', text: 'subagent work' }])
    session(db, 'sess_gone', { deleted: 2000 })
    message(db, 'sess_gone', 'm5', 1000, typed('t1'), [{ type: 'text', text: 'deleted' }])
    session(db, 'sess_empty')
    db.close()
    const found = await zcodeTranscripts(() => file).scan()
    expect(found.map((each) => each.sessionId).sort()).toEqual(['sess_a', 'sess_named'])
    expect(found.find((each) => each.sessionId === 'sess_a')).toEqual({ sessionId: 'sess_a', cwd: '/work/repo', title: 'Fix the parser', named: false, firstPrompt: 'Fix the parser', startedAt: 1000, modifiedAt: 9000, file: `${file}#sess_a` })
    expect(found.find((each) => each.sessionId === 'sess_named')).toMatchObject({ title: 'My session', named: true })
  })

  it('reads a session turn by turn as the chat shows one', async () => {
    const db = database()
    session(db, 'sess_a')
    message(db, 'sess_a', 'u1', 1000, typed('t1'), [{ type: 'text', text: 'write hello' }])
    message(db, 'sess_a', 'r1', 1000, reminder('t1'), [{ type: 'text', text: 'The TodoWrite tool hasn\'t been used' }])
    message(db, 'sess_a', 'a1', 1001, answer('t1'), [
      { type: 'step-start' },
      { type: 'reasoning', text: 'Need a file' },
      { type: 'tool', callID: 'call_1', tool: 'Write', state: { status: 'completed', input: { file_path: '/work/repo/hello.txt', content: 'hi\n' }, output: 'File created' } },
      { type: 'tool', callID: 'call_2', tool: 'Bash', state: { status: 'error', input: { command: 'rm x' }, error: 'not now' } },
      { type: 'tool', callID: 'call_3', tool: 'TodoWrite', state: { status: 'completed', input: { todos: [] } } }
    ])
    message(db, 'sess_a', 'a2', 1005, answer('t1'), [{ type: 'text', text: 'Done.' }, { type: 'step-finish', reason: 'stop' }])
    db.close()
    const transcript = await zcodeTranscripts(() => file).read(`${file}#sess_a`)
    expect(transcript.entries.map((entry) => entry.item)).toEqual([
      { id: 'u:u1', kind: 'user', text: 'write hello', images: [] },
      { id: 'r:a1-p1', kind: 'reasoning', text: 'Need a file', streaming: false },
      { id: 't:call_1', kind: 'tool', name: 'Write', title: '/work/repo/hello.txt', input: null, status: 'done', output: 'File created', diffs: [{ path: '/work/repo/hello.txt', change: 'add', patch: '+hi' }] },
      { id: 't:call_2', kind: 'tool', name: 'Bash', title: 'rm x', input: 'rm x', status: 'failed', output: 'not now', diffs: [], execution: { status: 'failed', exitCode: null } },
      { id: 'm:a2-p0', kind: 'assistant', text: 'Done.', streaming: false },
      { id: 'turn:t1', kind: 'turn', state: 'completed', error: null, durationMs: 5, usage: null, providerRef: 't1' }
    ])
    expect(transcript.messages).toEqual([
      { at: 1000, role: 'user', text: 'write hello', ref: 'u1' },
      { at: 1005, role: 'assistant', text: 'Done.', ref: 'u1' }
    ])
  })

  it('finds nothing where ZCode keeps no database', async () => {
    expect(await zcodeTranscripts(() => path.join(dir, 'missing.sqlite')).scan()).toEqual([])
    expect(zcodeSessionDb({ ZCODE_SESSION_DB_PATH: '/x/db.sqlite' }, '/home/user')).toBe('/x/db.sqlite')
    expect(zcodeSessionDb({}, '/home/user')).toBe('/home/user/.zcode/cli/db/db.sqlite')
  })
})
