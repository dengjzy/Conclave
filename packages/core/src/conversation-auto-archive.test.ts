import { mkdtempSync, rmSync } from 'node:fs'
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
})
