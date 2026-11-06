import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationDeletion } from './conversation-deletion'
import { ConversationStore } from './conversation-store'
import { TaskStore } from './task-store'
import type { NativeArtifact, NativeSession, NativeSessions } from './native-session'

describe('native session artifact ownership', () => {
  let root: string
  let file: string
  let tasks: TaskStore
  let store: ConversationStore
  const session = (artifacts?: NativeArtifact[]): NativeSession => ({ id: 'shared', root: '/shared-history', locator: '/shared-history/shared.db', cwd: '/project', ...(artifacts ? { artifacts } : {}) })
  const scope = (account: string): NativeArtifact => ({ root: path.join(root, account, 'brain'), locator: path.join(root, account, 'brain', 'shared') })
  const reopen = () => { store.close(); store = new ConversationStore(file) }
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-native-artifacts-'))
    file = path.join(root, 'conclave.db')
    tasks = new TaskStore(file)
    store = new ConversationStore(file)
  })
  afterEach(() => { store.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })

  it('retains captured artifacts before a native record exists and merges new account scopes first', () => {
    const conversation = store.create('antigravity', '/project', ['/project'])
    store.rememberNativeTarget(conversation.id, 'antigravity', 'shared', '/project', 'a', '/shared-history', [scope('a')])
    store.rememberNativeTarget(conversation.id, 'antigravity', 'shared', '/project', 'b', '/shared-history', [scope('b'), scope('a')])
    reopen()
    expect(store.nativeSessions([conversation.id])).toEqual([])
    expect(store.nativeTargets([conversation.id])).toMatchObject([{ artifacts: [scope('b'), scope('a')] }])
    store.rememberNativeSession(conversation.id, 'antigravity', 'shared', '/project', 'b', session())
    expect(store.nativeSessions([conversation.id])[0]?.session.artifacts).toEqual([scope('b'), scope('a')])
    store.rememberNativeTarget(conversation.id, 'antigravity', 'shared', '/project', 'c', '/shared-history', [scope('c')])
    expect(store.nativeSessions([conversation.id])[0]?.session.artifacts).toEqual([scope('c'), scope('b'), scope('a')])
  })

  it('does not hide another conversation’s pending artifact scopes behind an already resolved identity', () => {
    const resolved = store.create('antigravity', '/project', ['/project'])
    const pending = store.create('antigravity', '/project', ['/project'])
    store.rememberNativeSession(resolved.id, 'antigravity', 'shared', '/project', 'a', session([scope('a')]))
    store.rememberNativeTarget(pending.id, 'antigravity', 'shared', '/project', 'b', '/shared-history', [scope('b')])
    expect(store.nativeTargets([resolved.id, pending.id])).toMatchObject([{ artifacts: [scope('b')] }])
  })

  it('retains an older exact artifact locator when a later account captures a new scope', () => {
    const conversation = store.create('antigravity', '/project', ['/project'])
    store.rememberNativeSession(conversation.id, 'antigravity', 'shared', '/project', 'a', { ...session(), locator: scope('a').locator })
    store.rememberNativeTarget(conversation.id, 'antigravity', 'shared', '/project', 'b', '/shared-history', [scope('b')])
    reopen()
    expect(store.nativeSessions([conversation.id])[0]?.session.artifacts).toEqual([scope('b'), scope('a')])
  })

  it('merges repeated captures of one identity during collection and preserves all scopes in a failed job after restart', async () => {
    const conversation = store.create('antigravity', '/project', ['/project'])
    store.rememberNativeSession(conversation.id, 'antigravity', 'shared', '/project/a', 'a', session([scope('a')]))
    store.rememberNativeSession(conversation.id, 'antigravity', 'shared', '/project/b', 'b', session([scope('b')]))
    const removed: NativeSession[] = []
    let fail = true
    const adapter: NativeSessions = {
      resolve: async (target) => session(target.artifacts), children: async () => [],
      remove: async (native) => { if (fail) throw new Error('locked'); removed.push(native) }
    }
    const deletion = () => {
      const next = new ConversationDeletion(store, { quiesce: async () => {}, removeStopped: async (id) => { store.delete(id) }, changed: () => {} }, path.join(root, 'sessions'))
      next.configure({ adapter: () => adapter, executor: { command: async () => '', acp: async () => ({}) }, home: () => undefined })
      return next
    }
    await expect(deletion().delete(conversation.id)).rejects.toMatchObject({ reason: 'conversation-cleanup-failed' })
    reopen()
    expect(store.deletions()[0]?.entries[0]?.session.artifacts).toEqual([scope('b'), scope('a')])
    fail = false
    await deletion().recover()
    expect(removed).toHaveLength(1)
    expect(removed[0]?.artifacts).toEqual([scope('b'), scope('a')])
  })

  it('protects all artifact homes while a second conversation owns the shared history and clears them after its last owner', async () => {
    const first = store.create('antigravity', '/project', ['/project'])
    const second = store.create('antigravity', '/project', ['/project'])
    for (const account of ['a', 'b', 'c']) {
      mkdirSync(scope(account).locator, { recursive: true })
      writeFileSync(path.join(scope(account).locator, 'artifact.txt'), account)
    }
    store.rememberNativeSession(first.id, 'antigravity', 'shared', '/project', 'a', session([scope('a')]))
    store.rememberNativeSession(first.id, 'antigravity', 'shared', '/project', 'b', session([scope('b')]))
    store.rememberNativeTarget(second.id, 'antigravity', 'shared', '/project', 'c', '/shared-history', [scope('c')])
    const adapter: NativeSessions = {
      resolve: async (target) => session(target.artifacts), children: async () => [],
      remove: async (native) => { for (const artifact of native.artifacts ?? []) rmSync(artifact.locator, { recursive: true, force: true }) }
    }
    const deletion = () => {
      const next = new ConversationDeletion(store, { quiesce: async () => {}, removeStopped: async (id) => { store.delete(id) }, changed: () => {} }, path.join(root, 'sessions'))
      next.configure({ adapter: () => adapter, executor: { command: async () => '', acp: async () => ({}) }, home: () => undefined })
      return next
    }
    await deletion().delete(first.id)
    for (const account of ['a', 'b', 'c']) expect(existsSync(scope(account).locator)).toBe(true)
    reopen()
    await deletion().delete(second.id)
    for (const account of ['a', 'b', 'c']) expect(existsSync(scope(account).locator)).toBe(false)
    expect(store.deletions()).toEqual([])
  })
})
