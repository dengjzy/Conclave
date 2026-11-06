import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { AgentKind, agentDescriptor, type Conversation } from '@conclave/protocol'
import type { ConversationStore } from './conversation-store'
import { nativeSessionKey, type NativeSession, type NativeSessionExecutor, type NativeSessions } from './native-session'
import { Rejection } from './rejection'
import { readOwnedNativeSessions, readStageOwnedSessions } from './owned-native-sessions'

const Session = z.object({ id: z.string(), root: z.string(), locator: z.string(), cwd: z.string() })
const Entry = z.object({ agent: AgentKind, session: Session, children: z.array(z.string()), removed: z.boolean() })
export const ConversationDeletionJob = z.object({
  rootId: z.string(), conversationIds: z.array(z.string()), entries: z.array(Entry),
  collected: z.boolean(), localRemoved: z.boolean(), probe: z.boolean().optional(), ready: z.boolean().optional(), processSessionId: z.string().optional(), state: z.enum(['running', 'failed']), error: z.string().optional()
})
export type ConversationDeletionJob = z.infer<typeof ConversationDeletionJob>
export type NativeSessionDeletion = {
  adapter(agent: z.infer<typeof AgentKind>): NativeSessions | undefined
  executor: NativeSessionExecutor
  home(agent: z.infer<typeof AgentKind>, account: string | null): string | undefined
}

type Hooks = {
  quiesce(ids: readonly string[]): Promise<void>
  removeStopped(id: string): Promise<void>
  changed(ids: readonly string[]): void
  stopProbe?(id: string): Promise<void>
}

// Keep the identity mapping until every unshared native record is gone. A failed job is retryable
// without making the conversation runnable again, including after core restarts.
export class ConversationDeletion {
  private native: NativeSessionDeletion | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private probes: Promise<unknown> = Promise.resolve()
  private readonly inFlight = new Map<string, Promise<void>>()
  constructor(private readonly store: ConversationStore, private readonly hooks: Hooks, private readonly sessionsRoot: string) {}
  configure(native: NativeSessionDeletion): void { this.native = native }
  pending(id: string): Conversation['deletion'] {
    const job = this.store.deletionFor(id)
    return job ? { state: job.state, ...(job.error ? { error: job.error } : {}) } : undefined
  }
  requireWritable(id: string): void {
    if (this.store.deletionFor(id)) throw new Rejection('conversation-deleting', '会话正在删除，请重试清理或等待完成')
  }
  delete(id: string): Promise<void> {
    if (!this.store.deletions().some((job) => job.rootId === id) && this.store.get(id)) this.save({
      rootId: id, conversationIds: this.store.deletionTree(id), entries: [],
      collected: false, localRemoved: false, state: 'running'
    })
    const run = this.chain.catch(() => {}).then(async () => {
      await this.run(id)
      for (const job of this.store.deletions().filter((each) => each.localRemoved && !each.probe && each.rootId !== id)) {
        await this.run(job.rootId).catch((error: unknown) => console.warn('[conclave-core] deferred native deletion failed', error))
      }
    })
    this.chain = run
    return run
  }
  registerNative(agent: z.infer<typeof AgentKind>, session: NativeSession, processSessionId: string): void {
    const key = nativeSessionKey(agent, session)
    if (this.store.deletions().some((job) => job.probe && job.entries.some((entry) => nativeSessionKey(entry.agent, entry.session) === key))) return
    this.save({ rootId: `native:${randomUUID()}`, conversationIds: [], entries: [{ agent, session, children: [], removed: false }],
      collected: false, localRemoved: true, probe: true, ready: false, processSessionId, state: 'running' })
  }
  cleanupNative(agent: z.infer<typeof AgentKind>, session: NativeSession): Promise<void> {
    const key = nativeSessionKey(agent, session)
    const job = this.store.deletions().find((each) => each.probe && each.entries.some((entry) => nativeSessionKey(entry.agent, entry.session) === key)) ?? {
      rootId: `native:${randomUUID()}`, conversationIds: [], entries: [{ agent, session, children: [], removed: false }],
      collected: false, localRemoved: true, probe: true, state: 'running' as const
    }
    const activated: ConversationDeletionJob = { ...job, ready: true }
    this.save(activated)
    // A conversation start may be awaiting this probe while deletion waits for that start.
    const run = this.probes.catch(() => {}).then(() => this.run(activated.rootId))
    this.probes = run
    return run
  }
  async recoverDeferred(): Promise<void> {
    for (const job of this.store.deletions().filter((each) => each.localRemoved && !each.probe && each.state === 'running')) await this.delete(job.rootId)
  }
  async recover(): Promise<void> {
    for (const job of this.store.deletions()) {
      if (job.probe) { job.ready = true; this.save(job) }
      await this.delete(job.rootId).catch((error: unknown) => console.warn('[conclave-core] resuming conversation deletion failed', error))
    }
  }
  private save(job: ConversationDeletionJob): void {
    this.store.saveDeletion(job)
    this.hooks.changed(job.conversationIds)
  }
  private run(id: string): Promise<void> {
    const current = this.inFlight.get(id)
    if (current) return current
    const run = Promise.resolve().then(() => this.runJob(id)).finally(() => this.inFlight.delete(id))
    this.inFlight.set(id, run)
    return run
  }
  private async runJob(id: string): Promise<void> {
    const previous = this.store.deletions().find((job) => job.rootId === id)
    if (!previous && !this.store.get(id)) return
    const job: ConversationDeletionJob = previous ?? {
      rootId: id, conversationIds: this.store.deletionTree(id), entries: [],
      collected: false, localRemoved: false, state: 'running'
    }
    if (job.probe && !job.ready) return
    job.state = 'running'
    delete job.error
    this.save(job)
    try {
      if (job.processSessionId) {
        if (!this.hooks.stopProbe) throw new Error('临时智能体进程尚未确认退出')
        await this.hooks.stopProbe(job.processSessionId)
        delete job.processSessionId
        this.save(job)
      }
      if (!job.localRemoved) await this.hooks.quiesce(job.conversationIds)
      // A launch already in flight may only have recorded its native ID while stopping.
      if (!job.collected) {
        if (!job.localRemoved) job.conversationIds = [...new Set([...job.conversationIds, ...this.store.deletionTree(id)])]
        this.save(job)
        await this.collect(job)
        job.collected = true
        this.save(job)
      }
      await this.removeNative(job)
      if (!job.localRemoved) {
        for (const conversationId of [...job.conversationIds].reverse()) await this.hooks.removeStopped(conversationId)
        job.localRemoved = true
        this.save(job)
      }
      // Shared records stay owned by this durable job until their last other owner is removed.
      if (job.entries.every((entry) => entry.removed)) this.store.deleteDeletion(id)
    } catch (error) {
      job.state = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      this.save(job)
      throw new Rejection('conversation-cleanup-failed', `会话清理未完成：${job.error}`)
    }
  }
  private async targets(ids: readonly string[]): Promise<Array<{ agent: z.infer<typeof AgentKind>; providerSessionId: string; cwd: string; account: string | null; home?: string }>> {
    const owned = await Promise.all(ids.map((id) => readOwnedNativeSessions(this.sessionsRoot, id)))
    const children = ids.flatMap((id) => {
      const conversation = this.store.get(id)
      if (!conversation) return []
      return this.store.stages(id).filter((stage) => stage.sessionId !== null).flatMap((stage) => readStageOwnedSessions(this.sessionsRoot, id, stage.id, stage.agent,
        conversation.workspacePath, this.native?.home(stage.agent, stage.account ?? null)))
    })
    return [...this.store.nativeTargets(ids), ...owned.flat().map((session) => ({ ...session, account: null })),
      ...children.map((session) => ({ ...session, account: null }))]
  }
  private async collect(job: ConversationDeletionJob): Promise<void> {
    const native = this.native
    if (!native) return
    const entries = new Map(job.entries.map((entry) => [nativeSessionKey(entry.agent, entry.session), entry]))
    const visited = new Set<string>()
    const visit = async (agent: z.infer<typeof AgentKind>, session: NativeSession): Promise<void> => {
      const key = nativeSessionKey(agent, session)
      if (visited.has(key)) return
      visited.add(key)
      const entry: z.infer<typeof Entry> = entries.get(key) ?? { agent, session, children: [], removed: false }
      entries.set(key, entry)
      const adapter = native.adapter(agent)
      if (!adapter) throw new Error(`${agentDescriptor(agent).label} 暂不支持原生会话清理`)
      const children = await adapter.children(session)
      entry.children = children.map((child) => nativeSessionKey(agent, child))
      for (const child of children) await visit(agent, child)
    }
    for (const entry of [...entries.values()]) await visit(entry.agent, entry.session)
    for (const entry of this.store.nativeSessions(job.conversationIds)) await visit(entry.agent, entry.session)
    for (const target of await this.targets(job.conversationIds)) {
      const adapter = native.adapter(target.agent)
      if (!adapter) throw new Error(`${agentDescriptor(target.agent).label} 暂不支持原生会话清理`)
      const session = await adapter.resolve({ ...target, home: target.home ?? native.home(target.agent, target.account) })
      if (session) await visit(target.agent, session)
    }
    job.entries = [...entries.values()]
  }
  private async removeNative(job: ConversationDeletionJob): Promise<void> {
    const native = this.native
    if (!native) return
    const protectedKeys = new Set<string>()
    const visitProtected = async (agent: z.infer<typeof AgentKind>, session: NativeSession): Promise<void> => {
      const key = nativeSessionKey(agent, session)
      if (protectedKeys.has(key)) return
      protectedKeys.add(key)
      const adapter = native.adapter(agent)
      if (!adapter) return
      for (const child of await adapter.children(session)) await visitProtected(agent, child)
    }
    const deleting = new Set(job.conversationIds)
    const retained = this.store.list().filter((conversation) => !deleting.has(conversation.id)).map((conversation) => conversation.id)
    for (const entry of this.store.nativeSessions(retained)) await visitProtected(entry.agent, entry.session)
    for (const target of await this.targets(retained)) {
      const adapter = native.adapter(target.agent)
      if (!adapter) continue
      const session = await adapter.resolve({ ...target, home: target.home ?? native.home(target.agent, target.account) })
      if (session) await visitProtected(target.agent, session)
    }
    // Some official deletion APIs cascade: a shared child also protects its ancestors.
    let added = true
    while (added) {
      added = false
      for (const entry of job.entries) {
        const key = nativeSessionKey(entry.agent, entry.session)
        if (!protectedKeys.has(key) && entry.children.some((child) => protectedKeys.has(child))) {
          protectedKeys.add(key)
          added = true
        }
      }
    }
    for (const entry of [...job.entries].reverse()) {
      if (entry.removed || protectedKeys.has(nativeSessionKey(entry.agent, entry.session))) continue
      const adapter = native.adapter(entry.agent)
      if (!adapter) throw new Error(`${agentDescriptor(entry.agent).label} 暂不支持原生会话清理`)
      try { await adapter.remove(entry.session, native.executor) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      entry.removed = true
      this.save(job)
    }
  }
}
