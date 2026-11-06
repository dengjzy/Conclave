import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentProfile, type AgentKind } from '@conclave/protocol'
import { TaskStore } from './task-store'
import { ConversationStore } from './conversation-store'
import { ConversationDeletion } from './conversation-deletion'
import type { NativeSession, NativeSessionExecutor, NativeSessions } from './native-session'
import { ChatLog } from './chat-log'
import { ownedSessionLog } from './owned-native-sessions'

const executor: NativeSessionExecutor = { command: async () => '', acp: async () => ({}) }

describe('conversation native history deletion', () => {
  let root: string
  let tasks: TaskStore
  let store: ConversationStore
  let deletion: ConversationDeletion
  let removed: string[]
  let local: string[]
  let stopped: string[][]
  let children: Map<string, string[]>
  let fail: string | null
  let adapter: NativeSessions
  const ref = (id: string, cwd: string, home = '/shared-history'): NativeSession => ({ id, root: home, locator: id, cwd })
  const create = (agent: AgentKind = 'claude') => store.create(agent, '/project', ['/project'])
  const stage = (id: string, native: string, agent: AgentKind = 'claude') => store.startStage(id, agent, native, 0)
  const setup = () => {
    deletion = new ConversationDeletion(store, {
      quiesce: async (ids) => { stopped.push([...ids]) },
      removeStopped: async (id) => { local.push(id); store.deleteCalls(id); store.delete(id) },
      changed: () => {}
    }, path.join(root, 'sessions'))
    deletion.configure({ adapter: () => adapter, executor, home: () => undefined })
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-delete-'))
    const db = path.join(root, 'test.db')
    tasks = new TaskStore(db)
    store = new ConversationStore(db)
    removed = []; local = []; stopped = []; children = new Map(); fail = null
    adapter = {
      resolve: async (target) => ref(target.providerSessionId, target.cwd, target.home),
      children: async (session) => (children.get(session.id) ?? []).map((id) => ref(id, session.cwd, session.root)),
      remove: async (session) => { if (session.id === fail) throw new Error(`locked: ${session.id}`); removed.push(session.id) }
    }
    setup()
  })
  afterEach(() => { store.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })

  it('deletes every stage and completed delegate before the parent, preserving independent forks', async () => {
    const parent = create()
    const child = create('codex')
    const fork = create()
    store.setForkedFrom(fork.id, parent.id)
    store.setProfile(child.id, AgentProfile.parse({ id: child.id, name: 'Reviewer', agent: 'codex', archivedAt: null, createdAt: 0, updatedAt: 0 }), parent.id, null)
    stage(parent.id, 'first')
    stage(parent.id, 'second', 'dsh')
    stage(parent.id, 'first')
    stage(child.id, 'delegate', 'codex')
    stage(fork.id, 'independent')
    children.set('delegate', ['native-child'])
    await deletion.delete(parent.id)
    expect(new Set(removed)).toEqual(new Set(['native-child', 'delegate', 'second', 'first']))
    expect(removed.indexOf('native-child')).toBeLessThan(removed.indexOf('delegate'))
    expect(local).toEqual([child.id, parent.id])
    expect(stopped[0]).toEqual([parent.id, child.id])
    expect(store.get(fork.id)).not.toBeNull()
    expect(store.deletions()).toEqual([])
  })

  it('persists the deletion lock, reports errors and resumes completed native work after a restart', async () => {
    const parent = create()
    stage(parent.id, 'a-locked')
    stage(parent.id, 'z-already-removed')
    fail = 'a-locked'
    await expect(deletion.delete(parent.id)).rejects.toMatchObject({ reason: 'conversation-cleanup-failed' })
    expect(removed).toEqual(['z-already-removed'])
    expect(store.get(parent.id)).not.toBeNull()
    expect(deletion.pending(parent.id)).toMatchObject({ state: 'failed', error: 'locked: a-locked' })
    expect(() => deletion.requireWritable(parent.id)).toThrow('会话正在删除')
    store.close()
    store = new ConversationStore(path.join(root, 'test.db'))
    fail = null
    setup()
    await deletion.recover()
    expect(removed).toEqual(['z-already-removed', 'a-locked'])
    expect(store.get(parent.id)).toBeNull()
    expect(store.deletions()).toEqual([])
  })

  it('defers shared sessions and their cascading parents until the other owner is deleted', async () => {
    const first = create()
    const other = create()
    stage(first.id, 'parent-native')
    stage(other.id, 'shared-child')
    children.set('parent-native', ['shared-child'])
    await deletion.delete(first.id)
    expect(removed).toEqual([])
    expect(store.get(first.id)).toBeNull()
    expect(store.deletions()).toHaveLength(1)
    await deletion.delete(other.id)
    expect(removed).toContain('shared-child')
    expect(removed).toContain('parent-native')
    expect(store.deletions()).toEqual([])
  })

  it('freezes the complete tree before awaiting process shutdown', async () => {
    const parent = create()
    let release: (() => void) | undefined
    deletion = new ConversationDeletion(store, {
      quiesce: async () => { await new Promise<void>((resolve) => { release = resolve }) },
      removeStopped: async (id) => { store.delete(id) }, changed: () => {}
    }, path.join(root, 'sessions'))
    const run = deletion.delete(parent.id)
    expect(() => deletion.requireWritable(parent.id)).toThrow()
    await expect.poll(() => Boolean(release)).toBe(true)
    release?.()
    await run
  })

  it('collects a provider ID that only becomes known while the process stops', async () => {
    const parent = create()
    const pending = store.startStage(parent.id, 'claude', null, 0)
    deletion = new ConversationDeletion(store, {
      quiesce: async () => { store.setProviderSession(pending.id, 'late-session') },
      removeStopped: async (id) => { store.delete(id) }, changed: () => {}
    }, path.join(root, 'sessions'))
    deletion.configure({ adapter: () => adapter, executor, home: () => undefined })
    await deletion.delete(parent.id)
    expect(removed).toEqual(['late-session'])
  })

  it('remembers a native ID even if the stage later fails and is removed', async () => {
    const parent = create()
    const failed = store.startStage(parent.id, 'claude', null, 0)
    store.setProviderSession(failed.id, 'saved-before-failure')
    store.deleteStage(failed.id)
    await deletion.delete(parent.id)
    expect(removed).toEqual(['saved-before-failure'])
  })

  it('includes explicitly registered script sessions and protects another owner of the same session', async () => {
    const first = create()
    const other = create()
    for (const conversation of [first, other]) {
      const file = ownedSessionLog(path.join(root, 'sessions'), conversation.id)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ agent: 'dsh', providerSessionId: 'script-child', cwd: '/temporary', home: '/dsh-home' }) + '\n')
    }
    await deletion.delete(first.id)
    expect(removed).toEqual([])
    await deletion.delete(other.id)
    expect(removed).toContain('script-child')
    expect(store.deletions()).toEqual([])
  })

  it('keeps its mapping when a native adapter is unavailable, rather than reporting successful deletion', async () => {
    const parent = create('cursor')
    stage(parent.id, 'cannot-delete', 'cursor')
    deletion.configure({ adapter: () => undefined, executor, home: () => undefined })
    await expect(deletion.delete(parent.id)).rejects.toMatchObject({ reason: 'conversation-cleanup-failed' })
    expect(store.get(parent.id)).not.toBeNull()
    expect(local).toEqual([])
  })

  it('cleans a model probe while a main deletion is waiting for the launch that awaited the probe', async () => {
    const parent = create()
    deletion = new ConversationDeletion(store, {
      quiesce: async () => { await deletion.cleanupNative('kimi', ref('probe', '/temporary')) },
      removeStopped: async (id) => { store.delete(id) }, changed: () => {}
    }, path.join(root, 'sessions'))
    deletion.configure({ adapter: () => adapter, executor, home: () => undefined })
    await deletion.delete(parent.id)
    expect(removed).toEqual(['probe'])
    expect(store.deletions()).toEqual([])
  })

  it('uses a durable storage locator even when the default home has changed', async () => {
    const parent = create('dsh')
    stage(parent.id, 'old-home', 'dsh')
    store.rememberNativeSession(parent.id, 'dsh', 'old-home', '/project', null, ref('old-home', '/project', '/original-home'))
    let deletedRoot = ''
    adapter.resolve = async (target) => ref(target.providerSessionId, target.cwd, '/different-home')
    adapter.remove = async (session) => { deletedRoot = session.root }
    await deletion.delete(parent.id)
    expect(deletedRoot).toBe('/original-home')
  })

  it('recovers a registered probe only after stopping its persisted process lease', async () => {
    const events: string[] = []
    deletion = new ConversationDeletion(store, {
      quiesce: async () => {}, removeStopped: async () => {}, changed: () => {},
      stopProbe: async (id) => { events.push(`stop:${id}`) }
    }, path.join(root, 'sessions'))
    adapter.remove = async (session) => { events.push(`remove:${session.id}`) }
    deletion.configure({ adapter: () => adapter, executor, home: () => undefined })
    deletion.registerNative('kimi', ref('registered-probe', '/temporary'), 'daemon-probe')
    await deletion.recoverDeferred()
    expect(events).toEqual([])
    expect(store.deletions()[0]).toMatchObject({ ready: false, processSessionId: 'daemon-probe' })
    await deletion.recover()
    expect(events).toEqual(['stop:daemon-probe', 'remove:registered-probe'])
    expect(store.deletions()).toEqual([])
  })

  it('does not infer ownership from protocol frames copied into an independent fork', async () => {
    const parent = create('cursor'), fork = create('cursor')
    const original = stage(parent.id, 'cursor-parent', 'cursor')
    store.attachStage(original.id, 'daemon-original')
    const copied = store.startStage(fork.id, 'cursor', null, 0)
    store.setForkedFrom(fork.id, parent.id)
    const frame = { method: 'session/update', params: { update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'cursor-child' } } }
    ChatLog.of(path.join(root, 'sessions'), parent.id, original.id).append([{ dir: 'in', at: 1, frame }])
    ChatLog.of(path.join(root, 'sessions'), fork.id, copied.id).append([{ dir: 'in', at: 1, frame }])
    await deletion.delete(parent.id)
    expect(new Set(removed)).toEqual(new Set(['cursor-parent', 'cursor-child']))
    expect(store.get(fork.id)).not.toBeNull()
  })

  it('retains a captured home even before the native file has been created', async () => {
    const parent = create('dsh')
    stage(parent.id, 'pending-file', 'dsh')
    store.rememberNativeTarget(parent.id, 'dsh', 'pending-file', '/project', null, '/startup-home')
    let resolvedHome: string | undefined
    adapter.resolve = async (target) => { resolvedHome = target.home; return ref(target.providerSessionId, target.cwd, target.home ?? '/changed-home') }
    await deletion.delete(parent.id)
    expect(resolvedHome).toBe('/startup-home')
    expect(removed).toEqual(['pending-file'])
  })

  it('can retry deletion after a parent has already been removed locally', async () => {
    const parent = create()
    await deletion.delete(parent.id)
    await deletion.delete(parent.id)
    expect(store.deletions()).toEqual([])
  })
})
