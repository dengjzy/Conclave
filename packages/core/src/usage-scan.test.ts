import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { scanJsonl, scanOpenCode, scanUsageFiles, type ScanFile } from './usage-scan'
import { emptyParser, parseUsageLine } from './usage-events'

const roots: string[] = []
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), 'conclave-usage-scan-')); roots.push(dir); return dir }
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
const claude = (output: number) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-22T10:00:00Z', sessionId: 'session', message: {
  id: 'message', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }
} })

describe('native usage scanning', () => {
  it('resumes only completed lines and replaces growing Claude snapshots, including after truncation', async () => {
    const file = path.join(await root(), 'session.jsonl')
    await writeFile(file, `${claude(1)}\n${claude(4).slice(0, 50)}`)
    const first = await scanJsonl(file, 'claude', undefined)
    expect(first?.events).toMatchObject([{ input: 15, output: 1 }])
    await appendFile(file, `${claude(4).slice(50)}\n`)
    const next = await scanJsonl(file, 'claude', first?.checkpoint ?? undefined)
    expect(next).toMatchObject({ reset: false, events: [{ id: 'message/', output: 4 }] })
    expect(await scanJsonl(file, 'claude', next?.checkpoint ?? undefined)).toBeNull()
    await writeFile(file, `${claude(2)}\n`)
    expect(await scanJsonl(file, 'claude', next?.checkpoint ?? undefined)).toMatchObject({ reset: true, events: [{ output: 2 }] })
  })
  it('reads packed rollouts and discovers shared account directories only once', async () => {
    const dir = await root(), own = path.join(dir, 'own'), other = path.join(dir, 'other')
    await mkdir(path.join(own, 'sessions'), { recursive: true }); await mkdir(other)
    await symlink(path.join(own, 'sessions'), path.join(other, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir')
    const file = path.join(own, 'sessions', 'rollout.jsonl.zst')
    await writeFile(file, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session_meta', payload: { id: 's', model: 'gpt-6.1-sol' } })}\n${JSON.stringify({ type: 'event_msg', timestamp: '2026-10-22T10:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50 }, last_token_usage: { input_tokens: 50, output_tokens: 5 } } } })}\n`)))
    const found: ScanFile[] = []
    const result = await scanUsageFiles({ roots: [{ agent: 'codex', home: own }, { agent: 'codex', home: other }], checkpoints: {}, opencode: [] }, (file) => found.push(file))
    expect(result).toEqual({ files: 1, errors: [] }); expect(found[0]?.events[0]).toMatchObject({ input: 50, output: 5 })
  })
  it('keeps equal billable Codex deltas when totals grow and gives fork copies the same event identity', () => {
    const state = emptyParser()
    const line = (total: number) => JSON.stringify({ type: 'event_msg', timestamp: `2026-10-22T10:00:0${total === 20 ? 1 : 2}Z`, payload: {
      type: 'token_count', info: { total_token_usage: { input_tokens: total }, last_token_usage: { input_tokens: 10, output_tokens: 2 } }
    } })
    const one = parseUsageLine('codex', line(20), state)
    expect(parseUsageLine('codex', line(20), state)).toBeNull()
    const two = parseUsageLine('codex', line(30), state)
    expect(two?.input).toBe(10); expect(two?.id).not.toBe(one?.id)
    expect(parseUsageLine('codex', line(20), { ...emptyParser(), session: 'fork' })?.id).toBe(one?.id)
  })
  it('reads v2 messages without recounting migrated v1 sessions and leaves session aggregates unallocated', async () => {
    const file = path.join(await root(), 'opencode.db'), db = new DatabaseSync(file)
    db.exec(`CREATE TABLE session(id TEXT, directory TEXT); CREATE TABLE session_v2(id TEXT, directory TEXT);
      CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
      CREATE TABLE session_message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
      INSERT INTO session VALUES ('s','old'); INSERT INTO session_v2 VALUES ('s','new');`)
    const data = JSON.stringify({ role: 'assistant', modelID: 'model', providerID: 'provider', cost: 0,
      tokens: { input: 10, output: 2, cache: { read: 3, write: 0 } } })
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m', 's', Date.now(), data)
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?)').run('m', 's', Date.now(), data)
    db.close()
    const result = scanOpenCode(file)
    expect(result.events).toMatchObject([{ cwd: 'new', input: 13, output: 2, model: 'provider/model', costUsd: 0 }])
    expect(result.events).toHaveLength(1)
  })
})
