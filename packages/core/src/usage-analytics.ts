import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { UsageEvent, UsageScanStatus, forecastUsage, type AgentAccounts, type AgentUsage, type ChatItem, type ConversationStage,
  type UsageFilter, type UsageHistory, type UsageTotals, type QuotaSample } from '@conclave/protocol'
import { ScanCheckpoint, type ScanRequest, type ScanRoot } from './usage-scan'
import { meteredModels, usageEvent } from './usage-events'
import type { QuickDeps } from './quick-request'
import type { SmallModelJob } from './small-model-store'
import { calendarDays } from './dashboard-stats'

const FileMessage = z.object({ kind: z.literal('file'), file: z.string(), reset: z.boolean(), events: z.array(UsageEvent), checkpoint: ScanCheckpoint.nullable() })
const DoneMessage = z.object({ kind: z.literal('done'), files: z.number(), errors: z.array(z.string()) })
const Sample = z.object({ at: z.number(), used: z.number(), reset: z.number().nullable() })
export type UsageAnalyticsDeps = {
  roots(): ScanRoot[]
  opencode(): string[]
  accounts(): AgentAccounts
  stages(session?: string): ConversationStage[]
  changed(): void
  cursor?(): Promise<UsageEvent[]>
}

export class UsageAnalytics {
  private readonly db: DatabaseSync
  private worker: Worker | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private scanning: Promise<void> | null = null
  private rebuilding: Promise<void> | null = null
  private stopped = false
  private scanStatus: UsageScanStatus = { running: false, updatedAt: null, files: 0, errors: [] }
  private readonly starts = new Map<string, number>()

  constructor(file: string, private readonly deps: UsageAnalyticsDeps, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  start(): void {
    void this.scan()
    this.timer = setInterval(() => void this.scan(), 60_000)
    this.timer.unref()
  }

  async close(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await this.worker?.terminate()
    await this.scanning
    await this.rebuilding
    this.db.close()
  }

  status(): UsageScanStatus { return this.scanStatus }

  quick(facts: Parameters<NonNullable<QuickDeps['observe']>>[0], origin: 'quick' | 'warmup' = 'quick'): void {
    if (this.stopped) return
    const id = facts.id ?? randomUUID()
    const previous = this.db.prepare('SELECT data FROM usage_records WHERE file=? LIMIT 1').get(`${origin}:${id}`)
    if (previous) return
    const events = meteredModels(facts.metering).map((tokens, index) => {
      const event = usageEvent(facts.agent, `${origin}:${id}/${index}`, facts.endedAt ?? this.now(), { session: null, model: tokens.model, cwd: null, turn: null }, tokens,
        { origin, source: 'conclave', account: facts.account, identity: facts.identity, startedAt: facts.startedAt })
      return facts.unpriced ? { ...event, costUsd: null, costKind: null } : event
    })
    this.put(`${origin}:${id}`, events); this.deps.changed()
  }

  catchUp(items: (stage: ConversationStage) => ChatItem[], jobs: readonly SmallModelJob[]): Promise<void> {
    this.rebuilding ??= this.rebuild(items, jobs).finally(() => { this.rebuilding = null })
    return this.rebuilding
  }

  private async rebuild(items: (stage: ConversationStage) => ChatItem[], jobs: readonly SmallModelJob[]): Promise<void> {
    for (const stage of this.deps.stages()) {
      if (this.stopped) return
      if (stage.endedAt === null || this.db.prepare('SELECT stage FROM usage_rebuilt_stages WHERE stage=?').get(stage.id)) continue
      this.observe(stage, items(stage))
      this.db.prepare('INSERT OR IGNORE INTO usage_rebuilt_stages(stage) VALUES (?)').run(stage.id)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    for (const job of jobs) {
      if (this.stopped) return
      if (job.kind !== 'helper' && job.endedAt !== null && job.metering) this.quick({
        id: job.id, endedAt: job.endedAt, agent: job.agent, account: null, identity: null, startedAt: job.startedAt, metering: job.metering,
        unpriced: job.prices.length === 0
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  private identity(stage: ConversationStage): string | null {
    const saved = this.db.prepare('SELECT identity FROM usage_stage_identities WHERE stage = ?').get(stage.id)
    if (saved) return typeof saved.identity === 'string' ? saved.identity : null
    const identity = stage.endedAt === null ? this.deps.accounts().accounts.find((account) => account.agent === stage.agent && account.id === stage.account)?.email ?? null : null
    this.db.prepare('INSERT OR IGNORE INTO usage_stage_identities(stage,identity) VALUES (?,?)').run(stage.id, identity)
    return identity
  }

  attribute(event: UsageEvent): UsageEvent {
    if (!event.session || (event.origin !== 'transcript' && event.origin !== 'cursor')) return event
    const candidates = this.deps.stages(event.session).filter((stage) => stage.agent === event.agent && stage.providerSessionId === event.session &&
      event.at >= stage.startedAt && event.at <= (stage.endedAt ?? Infinity))
    const stage = candidates.length === 1 ? candidates[0] : undefined
    return stage ? { ...event, source: 'conclave', account: stage.account ?? (event.origin === 'cursor' ? 'default' : null), identity: this.identity(stage) ?? event.identity,
      ...(stage.route ? { costUsd: null, costKind: null } : {}) } : event
  }

  put(file: string, events: readonly UsageEvent[], reset = false): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (reset) this.db.prepare('DELETE FROM usage_records WHERE file = ?').run(file)
      const insert = this.db.prepare('INSERT INTO usage_records(file,id,at,data) VALUES (?,?,?,?) ON CONFLICT(file,id) DO UPDATE SET at=excluded.at,data=excluded.data')
      for (const event of events) {
        const attributed = this.attribute(event)
        insert.run(file, `${event.agent}/${event.id}`, event.at, JSON.stringify(attributed))
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  observe(stage: ConversationStage, items: readonly ChatItem[]): void {
    if (this.stopped) return
    for (const item of items) {
      if (item.kind === 'user') this.starts.set(stage.id, item.at)
      if (item.kind !== 'turn' || !item.metering) continue
      const events = meteredModels(item.metering).map((tokens, index) => {
        const event = usageEvent(stage.agent, `live:${stage.id}/${item.id}/${index}`, item.at,
        { session: stage.providerSessionId, model: tokens.model, cwd: null, turn: item.providerRef ?? item.id }, tokens, {
          origin: 'live', source: 'conclave', account: stage.account ?? null, identity: this.identity(stage),
          startedAt: item.durationMs === null ? this.starts.get(stage.id) ?? stage.startedAt : item.at - item.durationMs
        })
        return stage.route ? { ...event, costUsd: null, costKind: null } : event
      })
      this.put(`live:${stage.id}/${item.id}`, events, true)
      this.starts.delete(stage.id)
    }
  }

  observeQuota(usage: AgentUsage): void {
    if (this.stopped) return
    if (usage.status !== 'ok') return
    const identity = this.deps.accounts().accounts.find((entry) => entry.agent === usage.agent && entry.id === (usage.account ?? 'default'))?.email ?? null
    for (const window of usage.windows) {
      const scope = JSON.stringify([usage.agent, usage.account ?? 'default', window.kind, window.model])
      const previous = this.db.prepare('SELECT data FROM usage_quota_samples WHERE scope=? ORDER BY at DESC LIMIT 1').get(scope)
      const old = previous ? z.object({ identity: z.string().nullable(), used: z.number(), reset: z.number().nullable() }).safeParse(JSON.parse(String(previous.data))).data : null
      if (old && (old.identity !== identity || old.used > window.usedPercent || old.reset !== window.resetsAt)) this.db.prepare('DELETE FROM usage_quota_samples WHERE scope=?').run(scope)
      this.db.prepare('INSERT OR REPLACE INTO usage_quota_samples(scope,at,data) VALUES (?,?,?)').run(scope, usage.updatedAt,
        JSON.stringify({ at: usage.updatedAt, used: window.usedPercent, reset: window.resetsAt, identity }))
    }
    this.db.prepare('DELETE FROM usage_quota_samples WHERE at < ?').run(this.now() - 2 * 3600_000)
  }

  forecasts(readings: readonly AgentUsage[]) {
    return readings.flatMap((usage) => usage.windows.map((window) => {
      const scope = JSON.stringify([usage.agent, usage.account ?? 'default', window.kind, window.model])
      const samples: QuotaSample[] = this.db.prepare('SELECT data FROM usage_quota_samples WHERE scope=? ORDER BY at').all(scope)
        .map((row) => Sample.parse(JSON.parse(String(row.data))))
      return forecastUsage(usage, window, samples, this.now())
    }))
  }

  withRates(usage: AgentUsage): AgentUsage {
    if (this.stopped) return usage
    this.observeQuota(usage)
    const forecasts = this.forecasts([usage])
    return { ...usage, windows: usage.windows.map(({ recentRate: _previous, ...window }, index) => {
      const forecast = forecasts[index]
      return forecast && (forecast.basis === 'recent' || forecast.basis === 'idle') && forecast.percentPerHour !== null
        ? { ...window, recentRate: { percentPerHour: forecast.percentPerHour, measuredAt: usage.updatedAt } } : window
    }) }
  }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning
    if (this.stopped) return Promise.resolve()
    this.scanning = this.scanNow().catch((error: unknown) => {
      this.scanStatus = { ...this.scanStatus, errors: [error instanceof Error ? error.message : 'scan failed'] }
    }).finally(() => {
      this.scanStatus = { ...this.scanStatus, running: false }
      this.scanning = null; this.deps.changed()
    })
    return this.scanning
  }

  private async scanNow(): Promise<void> {
    this.scanStatus = { ...this.scanStatus, running: true }; this.deps.changed()
    const checkpoints = Object.fromEntries(this.db.prepare('SELECT file,data FROM usage_scan_files').all()
      .map((row) => [String(row.file), ScanCheckpoint.parse(JSON.parse(String(row.data)))]))
    const request: ScanRequest = { roots: this.deps.roots(), opencode: this.deps.opencode(), checkpoints }
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './usage-scan-worker-dev.mjs' : './usage-scan-worker.mjs', import.meta.url), { workerData: request })
      this.worker = worker
      let done = false
      worker.on('message', (raw: unknown) => {
        try {
          const file = FileMessage.safeParse(raw)
          if (file.success) {
            this.put(file.data.file, file.data.events, file.data.reset)
            if (file.data.checkpoint) this.db.prepare('INSERT OR REPLACE INTO usage_scan_files(file,data) VALUES (?,?)').run(file.data.file, JSON.stringify(file.data.checkpoint))
            return
          }
          const result = DoneMessage.parse(raw)
          done = true
          this.scanStatus = { running: true, updatedAt: this.now(), files: result.files, errors: result.errors }
        } catch (error) { void worker.terminate(); reject(error) }
      })
      worker.once('error', reject)
      worker.once('exit', (code) => { this.worker = null; if (done || this.stopped) resolve(); else reject(new Error(`usage worker exited (${code})`)) })
    })
    if (this.stopped) return
    if (this.deps.cursor) {
      try { this.put('cursor:events', await this.deps.cursor()) }
      catch { this.scanStatus.errors.push('cursor: usage unavailable') }
    }
  }

  events(since: number): UsageEvent[] {
    const canonical = new Map<string, UsageEvent>()
    for (const row of this.db.prepare('SELECT data FROM usage_records WHERE at >= ? ORDER BY file,id').all(since)) {
      const event = UsageEvent.parse(JSON.parse(String(row.data)))
      const key = `${event.agent}/${event.id}`
      const previous = canonical.get(key)
      if (!previous) canonical.set(key, event)
      else {
        const owner = previous.account === null && event.account !== null ? event : previous
        const measured = event.input + event.output > previous.input + previous.output ? event : previous
        const { input, output, cacheRead, cacheWrite, cacheWrite1h, costUsd, costKind, requestInputs } = measured
        canonical.set(key, { ...owner, model: measured.model ?? owner.model, input, output, cacheRead, cacheWrite, cacheWrite1h, costUsd, costKind, requestInputs })
      }
    }
    const events = [...canonical.values()]
    const suppressed = new Set<string>()
    const native = new Map<string, UsageEvent[]>()
    for (const event of events) if (event.origin === 'transcript' || event.origin === 'cursor') {
      const key = `${event.agent}/${event.session}`
      const group = native.get(key) ?? []; group.push(event); native.set(key, group)
    }
    for (const group of native.values()) group.sort((a, b) => a.at - b.at)
    const liveGroups = new Map<string, UsageEvent[]>()
    for (const event of events.filter((entry) => entry.origin === 'live')) {
      const key = `${event.agent}/${event.session}/${event.turn}`
      const group = liveGroups.get(key) ?? []; group.push(event); liveGroups.set(key, group)
    }
    for (const live of liveGroups.values()) {
      const first = live[0]
      if (!first?.session) continue
      const group = native.get(`${first.agent}/${first.session}`) ?? []
      const start = first.startedAt ?? first.at
      let low = 0, high = group.length
      while (low < high) { const middle = (low + high) >>> 1; if ((group[middle]?.at ?? Infinity) < start) low = middle + 1; else high = middle }
      const matching: UsageEvent[] = []
      for (let index = low; index < group.length; index++) {
        const event = group[index]
        if (!event || event.at > first.at + 2000) break
        if (event.precision === 'request') matching.push(event)
      }
      const total = (list: readonly UsageEvent[]) => list.reduce((sum, event) => sum + event.input + event.output, 0)
      if (!matching.length) continue
      for (const event of total(matching) >= total(live) ? live : matching) suppressed.add(`${event.agent}/${event.id}`)
    }
    return events.filter((event) => !suppressed.has(`${event.agent}/${event.id}`))
  }

  history(filter: UsageFilter): UsageHistory {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: filter.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    const key = (at: number) => {
      const parts = Object.fromEntries(date.formatToParts(at).map((part) => [part.type, part.value]))
      return `${parts.year}-${parts.month}-${parts.day}`
    }
    const days = calendarDays(key(this.now()), filter.range)
    const allowed = new Set(days)
    const matched = this.events(this.now() - (filter.range + 2) * 86400_000).filter((event) => allowed.has(key(event.at)) &&
      (filter.agent === undefined || event.agent === filter.agent) && (filter.account === undefined || event.account === filter.account) &&
      (filter.identity === undefined || event.identity === filter.identity) && (filter.model === undefined || event.model === filter.model) && (filter.source === undefined || event.source === filter.source))
    const events = matched.filter((event) => event.precision === 'request')
    const grouped = (by: (event: UsageEvent) => string) => {
      const groups = new Map<string, UsageEvent[]>()
      for (const event of events) { const name = by(event); const group = groups.get(name) ?? []; group.push(event); groups.set(name, group) }
      return [...groups.values()]
    }
    return {
      totals: usageTotals(events), unallocated: usageTotals(matched.filter((event) => event.precision === 'session')), scan: this.status(),
      days: days.map((day) => ({ day, ...usageTotals(events.filter((event) => event.precision === 'request' && key(event.at) === day)) })),
      models: grouped((event) => JSON.stringify([event.agent, event.model])).flatMap((group) => group[0] ? [{ agent: group[0].agent, model: group[0].model, ...usageTotals(group) }] : []).sort((a, b) => b.input + b.output - a.input - a.output),
      accounts: grouped((event) => JSON.stringify([event.agent, event.account, event.identity])).flatMap((group) => group[0] ? [{ agent: group[0].agent, account: group[0].account, identity: group[0].identity, ...usageTotals(group) }] : []).sort((a, b) => b.input + b.output - a.input - a.output),
      sessions: grouped((event) => JSON.stringify([event.agent, event.session])).flatMap((group) => group[0] ? [{ agent: group[0].agent, session: group[0].session, cwd: group[0].cwd, at: Math.max(...group.map((event) => event.at)), ...usageTotals(group) }] : []).sort((a, b) => b.at - a.at).slice(0, 100)
    }
  }
}

export function usageTotals(events: readonly UsageEvent[]): UsageTotals {
  const priced = events.filter((event) => event.costUsd !== null)
  const money = (kind?: UsageEvent['costKind']) => {
    const known = priced.filter((event) => kind === undefined || event.costKind === kind)
    return known.length ? known.reduce((sum, event) => sum + (event.costUsd ?? 0), 0) : null
  }
  return { requests: events.length, input: events.reduce((sum, event) => sum + event.input, 0), output: events.reduce((sum, event) => sum + event.output, 0),
    cacheRead: events.reduce((sum, event) => sum + (event.cacheRead ?? 0), 0), cacheWrite: events.reduce((sum, event) => sum + (event.cacheWrite ?? 0), 0),
    costUsd: money(), reportedUsd: money('reported'), estimatedUsd: money('estimated'), priced: priced.length }
}
