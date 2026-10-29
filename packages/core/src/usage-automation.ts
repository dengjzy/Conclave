import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { UsageAutomationEntry, UsageAutomationPolicy, accountUsage, agentDescriptor, quotaVerdict, type AgentAccounts, type AgentKind,
  type AgentUsage, type ResetCreditOutcome, type UsageAutomationState, type UsageWindow } from '@conclave/protocol'
import { WarmupUncertain } from './quota-warmup'

const HOUR = 3600_000
const Action = UsageAutomationEntry.extend({
  request: z.string(), credit: z.string().optional(), until: z.number(), attempts: z.number(), next: z.number(),
  identity: z.string().nullable()
})
type Action = z.infer<typeof Action>
const SavedPolicy = UsageAutomationPolicy.extend({ identity: z.string().nullable() })
export type AutomationDeps = {
  accounts(): AgentAccounts
  usage(): AgentUsage[]
  refresh(agent: AgentKind, account: string): Promise<void>
  switchAccount(agent: AgentKind, account: string): string | null
  warmup(agent: AgentKind, account: string): Promise<void>
  consume(agent: AgentKind, account: string, request: string, credit?: string): Promise<ResetCreditOutcome>
  restored(agent: AgentKind): void
}

export function dailyWarmSlot(times: readonly string[], zone: string, now: number): string | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]))
  const current = Number(parts.hour) * 60 + Number(parts.minute)
  const at = [...times].sort().reverse().find((time) => { const [hour, minute] = time.split(':').map(Number); const late = current - ((hour ?? 0) * 60 + (minute ?? 0)); return late >= 0 && late <= 60 })
  return at ? `${parts.year}-${parts.month}-${parts.day}/${at}` : null
}

function nextDailyMinutes(times: readonly string[], zone: string, now: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((part) => [part.type, part.value]))
  const current = Number(parts.hour) * 60 + Number(parts.minute)
  return Math.min(Infinity, ...times.map((time) => {
    const [hour = 0, minute = 0] = time.split(':').map(Number)
    return (hour * 60 + minute - current + 1440) % 1440 || 1440
  }))
}

function idleWindow(window: UsageWindow, now: number): boolean {
  return window.resetsAt !== null && (window.resetsAt <= now ||
    (window.usedPercent === 0 && window.resetsAt >= now + window.windowMinutes * 60_000 - 10 * 60_000))
}

export class UsageAutomation {
  private readonly db: DatabaseSync
  private readonly locks = new Map<string, Promise<unknown>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | null = null
  private stopped = false
  private readonly nextRead = new Map<string, number>()

  constructor(file: string, private readonly deps: AutomationDeps, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  state(): UsageAutomationState {
    return { policies: this.db.prepare('SELECT data FROM usage_automation_policies ORDER BY scope').all().map((row) => {
      const policy = SavedPolicy.parse(JSON.parse(String(row.data)))
      return { ...UsageAutomationPolicy.parse(policy), paused: !this.enabled(policy.agent, policy.account) }
    }),
      recent: this.actions().sort((a, b) => b.at - a.at).slice(0, 30).map((entry) => UsageAutomationEntry.parse(entry)) }
  }

  configure(policy: UsageAutomationPolicy): UsageAutomationState {
    if (this.stopped) throw new Error('系统正在退出')
    const capabilities = agentDescriptor(policy.agent).quotaAutomation
    if (!capabilities) throw new Error('该 Agent 不支持额度预热')
    if (!capabilities.resetCredits && (policy.weekReset || policy.expiringReset)) throw new Error('该 Agent 不支持自动用卡')
    if (!this.account(policy.agent, policy.account)) throw new Error('没有这个账号')
    this.db.prepare('INSERT OR REPLACE INTO usage_automation_policies(scope,data) VALUES (?,?)').run(`${policy.agent}/${policy.account}`,
      JSON.stringify({ ...policy, identity: this.account(policy.agent, policy.account)?.email ?? null }))
    return this.state()
  }

  start(): void { this.timer = setInterval(() => void this.tick(), 60_000); this.timer.unref() }
  async close(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.ticking; await Promise.allSettled(this.locks.values()); this.db.close() }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.ticking) return this.ticking
    this.ticking = this.pass().catch((error: unknown) => console.error('[conclave-core] quota automation:', error instanceof Error ? error.message : String(error)))
      .finally(() => { this.ticking = null })
    return this.ticking
  }

  private account(agent: AgentKind, id: string) { return this.deps.accounts().accounts.find((entry) => entry.agent === agent && entry.id === id) }
  private enabled(agent: AgentKind, account: string): boolean {
    const row = this.db.prepare('SELECT data FROM usage_automation_policies WHERE scope=?').get(`${agent}/${account}`)
    const saved = row ? SavedPolicy.parse(JSON.parse(String(row.data))) : null
    return Boolean(saved && saved.identity !== null && saved.identity === this.account(agent, account)?.email)
  }
  private actions(): Action[] { return this.db.prepare('SELECT data FROM usage_automation_log').all().map((row) => Action.parse(JSON.parse(String(row.data)))) }
  private save(action: Action): void {
    this.db.prepare('INSERT OR REPLACE INTO usage_automation_log(id,at,data) VALUES (?,?,?)').run(action.id, action.at, JSON.stringify(action))
  }
  private action(agent: AgentKind, account: string, kind: Action['kind'], id: string, until: number): Action {
    return this.actions().find((entry) => entry.id === id) ?? { id, agent, account, kind, at: this.now(), request: randomUUID(), until,
      attempts: 0, next: 0, state: 'pending', detail: null, identity: this.account(agent, account)?.email ?? null }
  }
  private async locked<T>(agent: AgentKind, account: string, run: () => Promise<T>): Promise<T> {
    const key = `${agent}/${account}`
    const previous = this.locks.get(key)
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(run)
    this.locks.set(key, pending)
    try { return await pending } finally { if (this.locks.get(key) === pending) this.locks.delete(key) }
  }

  async manual(agent: AgentKind, account: string, request: string, credit?: string): Promise<ResetCreditOutcome> {
    if (this.stopped) throw new Error('系统正在退出')
    return this.locked(agent, account, async () => {
      const action = this.action(agent, account, 'manual', request, this.now() + 7 * 24 * HOUR)
      if (action.agent !== agent || action.account !== account || (action.attempts > 0 && action.credit !== credit)) throw new Error('同一次用卡不能更换账号或重置卡')
      action.request = request; action.credit = credit
      return this.spend(action)
    })
  }

  async retry(id: string): Promise<UsageAutomationState> {
    if (this.stopped) throw new Error('系统正在退出')
    const action = this.actions().find((entry) => entry.id === id)
    if (!action || action.kind === 'warmup') throw new Error('没有可重试的用卡操作')
    await this.locked(action.agent, action.account, () => this.spend(action))
    return this.state()
  }

  async ensureQuota(agent: AgentKind): Promise<void> {
    if (this.stopped) return
    const state = this.deps.accounts(), account = state.active[agent] ?? 'default'
    if (this.deps.switchAccount(agent, account)) return
    const policy = this.state().policies.find((entry) => entry.agent === agent && entry.account === account)
    if (!agentDescriptor(agent).quotaAutomation?.resetCredits || !policy?.weekReset) return
    await this.locked(agent, account, async () => {
      await this.deps.refresh(agent, account)
      if (this.stopped) return
      if (!this.enabled(agent, account) || !this.state().policies.find((entry) => entry.agent === agent && entry.account === account)?.weekReset) return
      const reading = accountUsage(this.deps.usage(), agent, account), now = this.now()
      const week = reading?.windows.find((window) => window.kind === 'weekly' && window.model === null && window.usedPercent >= 100 && window.resetsAt !== null && window.resetsAt > now)
      if (!reading || reading.status !== 'ok' || !week?.resetsAt || this.deps.switchAccount(agent, account)) return
      if (this.actions().some((action) => action.agent === agent && action.account === account && action.kind === 'week' && action.state === 'completed' && action.until > now)) return
      const action = this.action(agent, account, 'week', `week/${agent}/${account}/${week.resetsAt}`, week.resetsAt)
      const credit = reading.resetCredits?.credits.find((entry) => entry.id && (entry.expiresAt === null || entry.expiresAt > now))
      if (!credit?.id || !reading.resetCredits?.usable || reading.resetCredits.available <= 0 || action.next > now || action.attempts >= 3) return
      action.credit ??= credit.id
      await this.spend(action).catch(() => {})
    })
  }

  private async spend(action: Action): Promise<ResetCreditOutcome> {
    const account = this.account(action.agent, action.account)
    if (!account || account.email !== action.identity) throw new Error('账号身份已改变，未使用重置卡')
    const unresolved = this.actions().find((entry) => entry.agent === action.agent && entry.account === action.account && entry.kind !== 'warmup' && entry.state === 'pending' && entry.attempts > 0 && entry.id !== action.id)
    if (unresolved) throw new Error('上次用卡结果尚未确认，请先重试上次操作')
    if (action.state === 'completed') return 'already-used'
    action.state = 'pending'; action.attempts++; action.at = this.now(); action.next = this.now() + 10 * 60_000
    this.save(action)
    try {
      const outcome = await this.deps.consume(action.agent, action.account, action.request, action.credit)
      action.state = outcome === 'reset' || outcome === 'already-used' ? 'completed' : 'failed'
      action.detail = outcome; this.save(action)
      if (action.state === 'completed') this.deps.restored(action.agent)
      return outcome
    } catch (error) {
      action.detail = error instanceof Error ? error.message : 'request failed'
      // A transport failure is unresolved; its request id survives a restart.
      this.save(action); throw error
    }
  }

  private async pass(): Promise<void> {
    const now = this.now()
    for (const policy of this.state().policies) {
      if (this.stopped) return
      if (!this.account(policy.agent, policy.account)?.signedIn || (!policy.daily.length && !policy.afterReset && !policy.expiringReset)) continue
      const scope = `${policy.agent}/${policy.account}`
      if ((this.nextRead.get(scope) ?? 0) > now) continue
      this.nextRead.set(scope, now + 5 * 60_000)
      await this.locked(policy.agent, policy.account, async () => {
        await this.deps.refresh(policy.agent, policy.account)
        if (this.stopped) return
        if (!this.enabled(policy.agent, policy.account)) return
        const current = this.state().policies.find((entry) => entry.agent === policy.agent && entry.account === policy.account)
        if (JSON.stringify(current) !== JSON.stringify(policy)) return
        const reading = accountUsage(this.deps.usage(), policy.agent, policy.account)
        if (!reading || reading.status !== 'ok' || now - reading.updatedAt > 30 * 60_000) return
        if (policy.expiringReset && reading.resetCredits?.usable) {
          const credit = reading.resetCredits.credits.find((entry) => entry.id && entry.expiresAt !== null && entry.expiresAt > now && entry.expiresAt - now <= 24 * HOUR)
          if (credit?.id && credit.expiresAt && reading.windows.some((window) => window.usedPercent > 0 && credit.clears.includes(window.kind) && (window.resetsAt === null || window.resetsAt > now))) {
            const action = this.action(policy.agent, policy.account, 'expiring', `expiring/${policy.agent}/${policy.account}/${credit.id}`, credit.expiresAt)
            action.credit = credit.id
            if (action.state !== 'completed' && action.attempts < 3 && action.next <= now) await this.spend(action).catch(() => {})
          }
        }
        const session = reading.windows.find((window) => window.kind === 'session' && window.model === null)
        const unused = reading.windows.find((window) => window.model === null && idleWindow(window, now))
        if (!unused || quotaVerdict(reading, now).state === 'exhausted') return
        const daily = session && idleWindow(session, now) ? dailyWarmSlot(policy.daily, policy.timeZone, now) : null
        const heldForDaily = session && idleWindow(session, now) && nextDailyMinutes(policy.daily, policy.timeZone, now) < session.windowMinutes
        const cooling = this.actions().some((entry) => entry.agent === policy.agent && entry.account === policy.account && entry.kind === 'warmup' && entry.state !== 'failed' && entry.until > now)
        // An idle endpoint may move its reset time on every read; do not warm it every poll.
        const reset = policy.afterReset && !heldForDaily && !cooling ? `reset/${unused.kind}/${unused.resetsAt}` : null
        const slot = daily ?? reset
        if (!slot) return
        const action = this.action(policy.agent, policy.account, 'warmup', `warmup/${policy.agent}/${policy.account}/${slot}`, now + (session?.windowMinutes ?? 300) * 60_000)
        if (action.state === 'completed' || (action.state === 'pending' && action.attempts > 0) || action.attempts >= 3 || action.next > now) return
        action.attempts++; action.at = now; action.next = now + 15 * 60_000 * 2 ** (action.attempts - 1)
        // Do not replay an ambiguous in-flight request after core restarts.
        action.state = 'pending'; action.detail = 'started'; this.save(action)
        try {
          await this.deps.warmup(policy.agent, policy.account)
          await this.deps.refresh(policy.agent, policy.account)
          action.state = 'completed'; action.detail = 'completed'; this.save(action)
        } catch (error) { action.state = error instanceof WarmupUncertain ? 'pending' : 'failed'; action.detail = error instanceof Error ? error.message : 'warmup failed'; this.save(action) }
      }).catch((error: unknown) => console.error('[conclave-core] quota automation account:', error instanceof Error ? error.message : String(error)))
    }
    this.db.prepare("DELETE FROM usage_automation_log WHERE at < ? AND json_extract(data,'$.state') != 'pending' AND id NOT IN (SELECT id FROM usage_automation_log ORDER BY at DESC LIMIT 30)").run(now - 90 * 24 * HOUR)
  }
}
