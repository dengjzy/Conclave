import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccounts, AgentUsage, UsageAutomationPolicy } from '@conclave/protocol'
import { TaskStore } from './task-store'
import { UsageAutomation, dailyWarmSlot, type AutomationDeps } from './usage-automation'
import { WarmupUncertain } from './quota-warmup'

let now = Date.parse('2026-10-22T01:05:00Z')
beforeEach(() => { now = Date.parse('2026-10-22T01:05:00Z') })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'conclave-usage-auto-')), file = path.join(root, 'conclave.db'), tasks = new TaskStore(file)
  const accounts: AgentAccounts = { accounts: [{ agent: 'codex', id: 'default', label: null, email: 'a@example.test', plan: null, signedIn: true, createdAt: 0 }], active: {}, autoSwitch: true }
  let reading: AgentUsage = { agent: 'codex', account: 'default', status: 'ok', updatedAt: now, windows: [{ kind: 'weekly', model: null, usedPercent: 100, resetsAt: now + 86400_000, windowMinutes: 10080 }], plan: null, error: null,
    resetCredits: { available: 2, usable: true, blockedBy: null, credits: [{ id: 'card', expiresAt: now + 3600_000, clears: ['weekly', 'session'], label: null }] } }
  const deps: AutomationDeps = { accounts: () => accounts, usage: () => [reading], refresh: vi.fn(async () => {}), switchAccount: vi.fn(() => null),
    warmup: vi.fn(async () => {}), consume: vi.fn<AutomationDeps['consume']>(async () => 'reset'), restored: vi.fn() }
  let automation = new UsageAutomation(file, deps, () => now)
  cleanups.push(async () => { await automation.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })
  const policy: UsageAutomationPolicy = { agent: 'codex', account: 'default', daily: [], timeZone: 'Asia/Shanghai', afterReset: false, weekReset: true, expiringReset: false }
  return { deps, accounts, policy, get automation() { return automation }, setReading(value: AgentUsage) { reading = value }, get reading() { return reading },
    async reopen() { await automation.close(); automation = new UsageAutomation(file, deps, () => now) } }
}

describe('quota automation', () => {
  it('defaults to no spending and tries switching accounts before a weekly reset', async () => {
    const ctx = setup()
    await ctx.automation.ensureQuota('codex'); expect(ctx.deps.consume).not.toHaveBeenCalled()
    ctx.automation.configure(ctx.policy)
    vi.mocked(ctx.deps.switchAccount).mockReturnValue('another')
    await ctx.automation.ensureQuota('codex'); expect(ctx.deps.consume).not.toHaveBeenCalled()
  })
  it('spends at most once until the original weekly window ends, across restarts', async () => {
    const ctx = setup(); ctx.automation.configure(ctx.policy)
    await ctx.automation.ensureQuota('codex')
    await ctx.reopen(); await ctx.automation.ensureQuota('codex')
    expect(ctx.deps.consume).toHaveBeenCalledTimes(1)
    expect(ctx.deps.restored).toHaveBeenCalledWith('codex')
  })
  it('reuses the persisted request id after an ambiguous network outcome', async () => {
    const ctx = setup(); ctx.automation.configure(ctx.policy)
    vi.mocked(ctx.deps.consume).mockRejectedValueOnce(new Error('connection lost'))
    await ctx.automation.ensureQuota('codex')
    const first = vi.mocked(ctx.deps.consume).mock.calls[0]
    await ctx.reopen(); now += 11 * 60_000
    await ctx.automation.ensureQuota('codex')
    expect(vi.mocked(ctx.deps.consume).mock.calls[1]).toEqual(first)
  })
  it('uses an expiring card only with eligible consumed quota and preserves explicit zero usage', async () => {
    const ctx = setup(); ctx.automation.configure({ ...ctx.policy, weekReset: false, expiringReset: true })
    ctx.setReading({ ...ctx.reading, windows: ctx.reading.windows.map((window) => ({ ...window, usedPercent: 0 })) })
    await ctx.automation.tick(); expect(ctx.deps.consume).not.toHaveBeenCalled()
    now += 5 * 60_000
    ctx.setReading({ ...ctx.reading, windows: ctx.reading.windows.map((window) => ({ ...window, usedPercent: 10 })) })
    await ctx.automation.tick(); expect(ctx.deps.consume).toHaveBeenCalledTimes(1)
  })
  it('deduplicates scheduled warmups through restarts without changing the active account', async () => {
    const ctx = setup(); ctx.automation.configure({ ...ctx.policy, weekReset: false, daily: ['09:00'] })
    ctx.setReading({ ...ctx.reading, windows: [{ kind: 'session', model: null, usedPercent: 0, resetsAt: now + 5 * 3600_000, windowMinutes: 300 }] })
    await ctx.automation.tick(); await ctx.reopen(); await ctx.automation.tick()
    expect(ctx.deps.warmup).toHaveBeenCalledTimes(1)
    expect(ctx.accounts.active).toEqual({})
  })
  it('does not repeat an uncertain warmup when an idle endpoint slides its reset time after a restart', async () => {
    const ctx = setup(); ctx.automation.configure({ ...ctx.policy, weekReset: false, afterReset: true })
    ctx.setReading({ ...ctx.reading, windows: [{ kind: 'session', model: null, usedPercent: 0, resetsAt: now + 5 * 3600_000, windowMinutes: 300 }] })
    vi.mocked(ctx.deps.warmup).mockRejectedValue(new WarmupUncertain())
    await ctx.automation.tick(); await ctx.reopen()
    now += 5 * 60_000
    ctx.setReading({ ...ctx.reading, windows: ctx.reading.windows.map((window) => ({ ...window, resetsAt: now + 5 * 3600_000 })) })
    await ctx.automation.tick()
    expect(ctx.deps.warmup).toHaveBeenCalledTimes(1)
    expect(ctx.automation.state().recent[0]?.state).toBe('pending')
  })
  it('does not mistake a running window rounded to zero percent for a new window at a daily start', async () => {
    const ctx = setup(); ctx.automation.configure({ ...ctx.policy, weekReset: false, daily: ['09:00'], afterReset: true })
    ctx.setReading({ ...ctx.reading, windows: [
      { kind: 'session', model: null, usedPercent: 20, resetsAt: now + 2 * 3600_000, windowMinutes: 300 },
      { kind: 'weekly', model: null, usedPercent: 0, resetsAt: now + 6 * 86400_000, windowMinutes: 10080 }
    ] })
    await ctx.automation.tick()
    expect(ctx.deps.warmup).not.toHaveBeenCalled()
  })
  it('serializes manual and automatic spending and blocks a second unresolved request', async () => {
    const ctx = setup(); ctx.automation.configure(ctx.policy)
    vi.mocked(ctx.deps.consume).mockRejectedValueOnce(new Error('timeout'))
    await expect(ctx.automation.manual('codex', 'default', 'same-request', 'card')).rejects.toThrow('timeout')
    await ctx.automation.ensureQuota('codex')
    expect(ctx.deps.consume).toHaveBeenCalledTimes(1)
    await ctx.automation.manual('codex', 'default', 'same-request', 'card')
    expect(vi.mocked(ctx.deps.consume).mock.calls[1]?.[2]).toBe('same-request')
  })
  it('pauses configured spending when the same local account signs in as someone else', async () => {
    const ctx = setup(); ctx.automation.configure(ctx.policy)
    const account = ctx.accounts.accounts[0]
    if (!account) throw new Error('missing account fixture')
    account.email = 'different@example.test'
    await ctx.automation.ensureQuota('codex')
    expect(ctx.deps.consume).not.toHaveBeenCalled()
    expect(ctx.automation.state().policies[0]?.paused).toBe(true)
  })
  it('rejects a retry whose request id is reused with a different credit', async () => {
    const ctx = setup()
    await ctx.automation.manual('codex', 'default', 'request', 'card')
    await expect(ctx.automation.manual('codex', 'default', 'request', 'other-card')).rejects.toThrow('不能更换')
    expect(ctx.deps.consume).toHaveBeenCalledTimes(1)
  })
  it('uses the configured time zone and skips missed starts beyond an hour, including DST boundaries', () => {
    expect(dailyWarmSlot(['09:00'], 'Asia/Shanghai', Date.parse('2026-10-22T01:30:00Z'))).toBe('2026-10-22/09:00')
    expect(dailyWarmSlot(['09:00'], 'Asia/Shanghai', Date.parse('2026-10-22T03:00:00Z'))).toBeNull()
    expect(dailyWarmSlot(['01:30'], 'America/New_York', Date.parse('2026-11-01T06:45:00Z'))).toBe('2026-11-01/01:30')
  })
})
