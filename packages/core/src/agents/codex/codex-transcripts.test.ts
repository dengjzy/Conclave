import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexTranscript, codexTranscripts } from './codex-transcripts'

const THREAD = '01a15e1a-0a9c-7c41-a755-ab1f2e3ed8d3'
const at = (second: number) => `2026-10-01T10:00:${String(second).padStart(2, '0')}.000Z`
const meta = (extra: object = {}) => ({ timestamp: at(0), type: 'session_meta', payload: { id: THREAD, timestamp: at(0), cwd: '/work/app', originator: 'codex-tui', source: 'cli', thread_source: 'user', ...extra } })
const event = (second: number, payload: object) => ({ timestamp: at(second), type: 'event_msg', payload })
const done = (second: number, turn: string, item: object) => event(second, { type: 'item_completed', turn_id: turn, item })
const said = (role: string, text: string) => ({ timestamp: at(1), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } })

// A thread as Codex writes one: its instructions sent as the user's, then two turns, the second
// stopped by the user.
const LINES = [
  meta(),
  said('developer', '<permissions instructions>'),
  said('user', '# AGENTS.md instructions for /work/app\n\n<INSTRUCTIONS>…'),
  event(1, { type: 'task_started', turn_id: 't1' }),
  said('user', 'List the files'),
  done(1, 't1', { type: 'UserMessage', id: 'item-1', content: [{ type: 'text', text: 'List the files' }] }),
  done(2, 't1', { type: 'Reasoning', id: 'item-2', summary_text: ['**Listing**'] }),
  done(3, 't1', { type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'ls'], parsed_cmd: [{ type: 'list_files', cmd: 'ls', path: '.' }], status: 'completed', exit_code: 0, aggregated_output: 'a.ts\n' }),
  done(4, 't1', { type: 'FileChange', id: 'exec-2', status: 'completed', changes: { '/work/app/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b' } } }),
  done(5, 't1', { type: 'AgentMessage', id: 'item-3', content: [{ type: 'Text', text: 'One file, now changed.' }] }),
  event(5, { type: 'task_complete', turn_id: 't1', last_agent_message: 'One file, now changed.' }),
  // A process that ran it later counts its items from one again.
  event(6, { type: 'task_started', turn_id: 't2' }),
  done(6, 't2', { type: 'UserMessage', id: 'item-1', content: [{ type: 'text', text: 'Now test it' }] }),
  done(7, 't2', { type: 'ContextCompaction', id: 'item-2' }),
  event(8, { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' })
].map((line) => JSON.stringify(line))

describe('codexTranscript', () => {
  it('shows each turn from the items it reported, the instructions left out', () => {
    const { entries, messages } = codexTranscript(LINES)
    expect(entries.map((entry) => [entry.item.kind, entry.item.id])).toEqual([
      ['user', 'u:t1:item-1'],
      ['reasoning', 'r:t1:item-2'],
      ['tool', 't:t1:exec-1'],
      ['tool', 't:t1:exec-2'],
      ['assistant', 'm:t1:item-3'],
      ['turn', 'turn:t1'],
      ['user', 'u:t2:item-1'],
      ['notice', 'n:t2:item-2'],
      ['turn', 'turn:t2']
    ])
    expect(entries[2]!.item).toMatchObject({ name: 'commandExecution', title: 'ls', description: '列出 . 里的文件', status: 'done', output: 'a.ts\n', execution: { status: 'completed', exitCode: 0 } })
    expect(entries[3]!.item).toMatchObject({ name: 'fileChange', title: '/work/app/a.ts', diffs: [{ path: '/work/app/a.ts', change: 'update', patch: '@@ -1 +1 @@\n-a\n+b' }] })
    expect(entries[5]!.item).toMatchObject({ state: 'completed', providerRef: 't1', durationMs: 4000 })
    expect(entries[8]!.item).toMatchObject({ state: 'interrupted', providerRef: 't2' })
    expect(messages.map(({ role, text, ref }) => [role, text, ref])).toEqual([
      ['user', 'List the files', 't1:item-1'],
      ['assistant', 'One file, now changed.', 't1:item-1'],
      ['user', 'Now test it', 't2:item-1']
    ])
  })

  it('shows the messages alone of a thread from before Codex reported its items', () => {
    const lines = [meta(), said('user', '<environment_context>…</environment_context>'), said('user', 'Hello'), said('assistant', 'Hi')].map((line) => JSON.stringify(line))
    expect(codexTranscript(lines).entries.map((entry) => [entry.item.kind, 'text' in entry.item ? entry.item.text : ''])).toEqual([['user', 'Hello'], ['assistant', 'Hi']])
  })

  // codex-cli 0.160: image_gen records its picture as an Extension item, the bytes and where it saved them.
  it('shows a picture Codex drew from where it saved it, and a web search as one', () => {
    const lines = [
      meta(),
      event(1, { type: 'task_started', turn_id: 't1' }),
      done(2, 't1', { type: 'Extension', kind: 'image_gen.generation', id: 'exec-1', status: 'completed', revisedPrompt: 'A felt ant', result: 'iVBORw0KGgo', transparentBackground: false, failure: null, savedPath: '/home/me/.codex/generated_images/t/exec-1.png' }),
      done(3, 't1', { type: 'Extension', kind: 'web.search', id: 'exec-2', query: 'felt ants', action: { type: 'search' } }),
      event(4, { type: 'task_complete', turn_id: 't1', last_agent_message: null })
    ].map((line) => JSON.stringify(line))
    const tools = codexTranscript(lines).entries.flatMap((entry) => entry.item.kind === 'tool' ? [entry.item] : [])
    expect(tools).toMatchObject([
      { name: 'imageGeneration', title: '/home/me/.codex/generated_images/t/exec-1.png', input: 'A felt ant', status: 'done', output: null },
      { name: 'webSearch', title: 'felt ants' }
    ])
  })
})

describe('codexTranscripts', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'conclave-codex-home-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('lists the threads the user started, packed or not, by the name Codex gave them', async () => {
    const day = path.join(home, 'sessions', '2026', '10', '01')
    mkdirSync(day, { recursive: true })
    const rollout = (id: string) => path.join(day, `rollout-2026-10-01T10-00-00-${id}.jsonl`)
    const text = (lines: readonly string[]) => `${lines.join('\n')}\n`
    writeFileSync(`${rollout(THREAD)}.zst`, zstdCompressSync(Buffer.from(text(LINES))))
    // Being written still: the plain file is the one that counts.
    writeFileSync(rollout(THREAD), text(LINES))
    const packed = '01a15e1a-0000-7000-8000-000000000002'
    writeFileSync(`${rollout(packed)}.zst`, zstdCompressSync(Buffer.from(text([JSON.stringify(meta({ id: packed })), ...LINES.slice(1)]))))
    // A subagent's review, and a thread Conclave itself started: neither the user's to import.
    const others = [{ source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' }, { originator: 'conclave', thread_source: null }]
    others.forEach((extra, index) => {
      const id = `01a15e1a-0000-7000-8000-00000000001${index}`
      writeFileSync(rollout(id), text([JSON.stringify(meta({ id, ...extra })), ...LINES.slice(1)]))
    })
    writeFileSync(path.join(home, 'session_index.jsonl'), `${JSON.stringify({ id: THREAD, thread_name: 'List and change files', updated_at: at(9) })}\n`)

    const sessions = await codexTranscripts(() => home).scan()
    expect(sessions.map(({ sessionId, title, firstPrompt, file }) => ({ sessionId, title, firstPrompt, file })).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: packed, title: 'List the files', firstPrompt: 'List the files', file: `${rollout(packed)}.zst` },
      { sessionId: THREAD, title: 'List and change files', firstPrompt: 'List the files', file: rollout(THREAD) }
    ])
    const read = await codexTranscripts(() => home).read(`${rollout(packed)}.zst`)
    expect(read.entries).toHaveLength(9)
  })

  it('prunes session_index.jsonl and codex sqlite databases on session delete', async () => {
    const day = path.join(home, 'sessions', '2026', '10', '01')
    mkdirSync(day, { recursive: true })
    const rolloutFile = path.join(day, `rollout-2026-10-01T10-00-00-${THREAD}.jsonl`)
    writeFileSync(rolloutFile, `${LINES.join('\n')}\n`)
    writeFileSync(`${rolloutFile}.zst`, zstdCompressSync(Buffer.from('packed')))

    // Set up session_index.jsonl with two sessions
    const otherThread = '01a15e1a-0000-7000-8000-000000000099'
    writeFileSync(
      path.join(home, 'session_index.jsonl'),
      `${JSON.stringify({ id: THREAD, thread_name: 'Target Session' })}\n${JSON.stringify({ id: otherThread, thread_name: 'Other Session' })}\n`
    )

    // Set up state_5.sqlite
    const stateDb = new DatabaseSync(path.join(home, 'state_5.sqlite'))
    stateDb.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE thread_dynamic_tools (thread_id TEXT);
      CREATE TABLE thread_spawn_edges (thread_id TEXT);
      CREATE TABLE thread_attachments (thread_id TEXT);
      CREATE TABLE thread_read_receipts (thread_id TEXT);
    `)
    stateDb.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run(THREAD, 'Target Session')
    stateDb.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run(otherThread, 'Other Session')
    stateDb.prepare('INSERT INTO thread_attachments (thread_id) VALUES (?)').run(THREAD)
    stateDb.close()

    // Set up thread_history_1.sqlite
    const historyDb = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'))
    historyDb.exec(`
      CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT);
      CREATE TABLE thread_items (thread_id TEXT, item_id TEXT);
    `)
    historyDb.prepare('INSERT INTO thread_turns (thread_id, turn_id) VALUES (?, ?)').run(THREAD, 't1')
    historyDb.prepare('INSERT INTO thread_items (thread_id, item_id) VALUES (?, ?)').run(THREAD, 'i1')
    historyDb.prepare('INSERT INTO thread_turns (thread_id, turn_id) VALUES (?, ?)').run(otherThread, 't9')
    historyDb.close()

    // Delete the session via Conclave
    await codexTranscripts(() => home).delete?.(rolloutFile)

    // Rollout files should be gone
    expect(existsSync(rolloutFile)).toBe(false)
    expect(existsSync(`${rolloutFile}.zst`)).toBe(false)

    // session_index.jsonl should have removed THREAD and kept otherThread
    const indexContent = readFileSync(path.join(home, 'session_index.jsonl'), 'utf8')
    expect(indexContent).not.toContain(THREAD)
    expect(indexContent).toContain(otherThread)

    // state_5.sqlite should have THREAD pruned
    const checkStateDb = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true })
    expect(checkStateDb.prepare('SELECT id FROM threads WHERE id = ?').get(THREAD)).toBeUndefined()
    expect(checkStateDb.prepare('SELECT id FROM threads WHERE id = ?').get(otherThread)).toBeDefined()
    expect(checkStateDb.prepare('SELECT thread_id FROM thread_attachments WHERE thread_id = ?').get(THREAD)).toBeUndefined()
    checkStateDb.close()

    // thread_history_1.sqlite should have THREAD pruned
    const checkHistDb = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'), { readOnly: true })
    expect(checkHistDb.prepare('SELECT thread_id FROM thread_turns WHERE thread_id = ?').get(THREAD)).toBeUndefined()
    expect(checkHistDb.prepare('SELECT thread_id FROM thread_turns WHERE thread_id = ?').get(otherThread)).toBeDefined()
    checkHistDb.close()
  })
})
