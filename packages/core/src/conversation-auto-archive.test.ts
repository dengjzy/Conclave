import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationAutoArchive } from './conversation-auto-archive'
import { ConversationStore } from './conversation-store'
import { TaskStore } from './task-store'

const DAY = 24 * 60 * 60_000

describe('ConversationStore.idleSince', () => {
  let root: string
  let clock: number
  let tasks: TaskStore
  let store: ConversationStore

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-auto-archive-'))
    const db = path.join(root, 'conclave.db')
    clock = 0
    tasks = new TaskStore(db)
    store = new ConversationStore(db, () => clock)
  })

  afterEach(() => {
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('finds the free conversations nobody has touched, and nothing pinned or belonging elsewhere', () => {
    const idle = store.create('claude', root, []).id
    const pinned = store.create('claude', root, []).id
    store.setPinned(pinned, true)
    const named = { id: '00000000-0000-4000-8000-000000000001', title: '固定标题' }
    store.create('claude', root, [], undefined, {}, named)
    store.create('claude', root, [], undefined, {}, null, null, named)
    store.create('claude', root, [], undefined, {}, null, null, null, idle)
    store.setSquad(store.create('claude', root, []).id, 'run', false)
    const archived = store.create('claude', root, []).id
    store.setArchived(archived, true)
    clock = 10 * DAY
    const active = store.create('claude', root, []).id
    expect(store.idleSince(5 * DAY)).toEqual([idle])
    expect(store.idleSince(11 * DAY)).toContain(active)
  })

  it('counts taking a conversation out of the archive as activity', () => {
    const id = store.create('claude', root, []).id
    store.setArchived(id, true)
    clock = 10 * DAY
    store.setArchived(id, false)
    expect(store.idleSince(5 * DAY)).toEqual([])
    expect(store.idleSince(11 * DAY)).toEqual([id])
    // Taking it out is not activity for the list's order.
    expect(store.get(id)?.updatedAt).toBe(0)
  })

  it('prunes oversized messages on archived conversations older than cutoff', () => {
    const chat = store.create('claude', root, [])
    const stage = store.startStage(chat.id, 'claude', null, 0)
    store.addMessage({
      conversationId: chat.id,
      stageId: stage.id,
      role: 'assistant',
      agent: 'claude',
      text: 'x'.repeat(10000),
      eventKey: 'e1',
      complete: true
    })
    store.addMessage({
      conversationId: chat.id,
      stageId: stage.id,
      role: 'user',
      agent: 'claude',
      text: 'short message',
      eventKey: 'e2',
      complete: true
    })

    // Active conversation: prune does nothing
    expect(store.pruneArchivedMessages(100 * DAY, 1000)).toBe(0)

    // Archive conversation at clock = 10 * DAY
    clock = 10 * DAY
    store.setArchived(chat.id, true)

    // If cutoff is before archive time, does not prune
    expect(store.pruneArchivedMessages(5 * DAY, 1000)).toBe(0)

    // If cutoff is after archive time, prunes large message
    expect(store.pruneArchivedMessages(15 * DAY, 1000)).toBe(1)
    const msgs = store.messages(chat.id)
    expect(msgs[0]?.text.length).toBeLessThan(1100)
    expect(msgs[0]?.text).toContain('[超期归档输出已精简]')
    expect(msgs[1]?.text).toBe('short message')
  })

  it('prunes finished routine runs in scheduled_runs older than cutoff', () => {
    const rawDb = new DatabaseSync(path.join(root, 'conclave.db'))
    rawDb.exec(`
      INSERT INTO scheduled_runs (id, target, title, agent, position, status, routine_id, due_at, finished_at, created_at, updated_at)
      VALUES
        ('run-1', '{}', 'Old routine', 'claude', 1.0, 'completed', 'routine-1', 1000, 2000, 1000, 2000),
        ('run-2', '{}', 'Recent routine', 'claude', 2.0, 'completed', 'routine-1', 5000, 6000, 5000, 6000),
        ('run-3', '{}', 'Unfinished routine', 'claude', 3.0, 'running', 'routine-1', 9000, NULL, 9000, 9000);
    `)

    expect(store.pruneFinishedRoutines(4000)).toBe(1)
    const remaining = rawDb.prepare('SELECT id FROM scheduled_runs ORDER BY id').all() as Array<{ id: string }>
    expect(remaining.map((r) => r.id)).toEqual(['run-2', 'run-3'])
    rawDb.close()
  })
})

describe('ConversationAutoArchive', () => {
  it('archives what was idle longer than the days allowed, and passes over what refuses', async () => {
    const asked: number[] = []
    const archived: string[] = []
    const sweeper = new ConversationAutoArchive(
      () => 30,
      (before) => { asked.push(before); return ['quiet', 'busy', 'old'] },
      async (id) => { if (id === 'busy') throw new Error('the agent is still working'); archived.push(id) },
      () => 100 * DAY
    )
    expect(await sweeper.sweep()).toBe(2)
    expect(asked).toEqual([70 * DAY])
    expect(archived).toEqual(['quiet', 'old'])
  })

  it('does nothing while it is off', async () => {
    let asked = false
    const sweeper = new ConversationAutoArchive(() => null, () => { asked = true; return ['quiet'] }, async () => {})
    expect(await sweeper.sweep()).toBe(0)
    expect(asked).toBe(false)
  })

  it('runs one sweep at a time', async () => {
    let calls = 0
    const sweeper = new ConversationAutoArchive(() => 7, () => { calls++; return [] }, async () => {})
    await Promise.all([sweeper.sweep(), sweeper.sweep()])
    expect(calls).toBe(1)
  })

  it('triggers maintenance callback with retention period during sweep', async () => {
    let retention: number | null = null
    const sweeper = new ConversationAutoArchive(
      () => 60,
      () => [],
      async () => {},
      () => 100 * DAY,
      (retentionMs) => { retention = retentionMs }
    )
    await sweeper.sweep()
    expect(retention).toBe(60 * DAY)
  })
})
