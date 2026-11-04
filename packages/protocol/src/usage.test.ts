import { describe, expect, it } from 'vitest'
import { AgentUsage, LEGACY_USAGE_WINDOW_KINDS, QUOTA_STALE_MS, UsageBalance, quotaVerdict, tightestWindow, usageLevel, usageReadable, type UsageWindow } from './usage'

const window = (usedPercent: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  kind: 'weekly',
  model: null,
  usedPercent,
  windowMinutes: 10_080,
  resetsAt: null,
  ...extra
})

const NOW = 1_790_000_000_000
const balance: UsageBalance = { id: 'deepseek', name: 'DeepSeek', currency: 'CNY', total: 12.5, granted: 2.5, toppedUp: 10, available: true }

const usage = (windows: UsageWindow[], extra: Partial<AgentUsage> = {}): AgentUsage => ({
  agent: 'claude',
  status: 'ok',
  windows,
  plan: 'max',
  error: null,
  updatedAt: NOW,
  resetCredits: null,
  ...extra
})

describe('AgentUsage balances', () => {
  it('accepts older readings without balances and adds balances without changing windows', () => {
    const legacy = usage([window(20)])
    expect(AgentUsage.parse(legacy)).toEqual(legacy)
    const reading = usage([], { balances: [balance] })
    expect(AgentUsage.parse(reading)).toEqual(reading)
    expect(AgentUsage.omit({ balances: true }).parse(reading)).toEqual(usage([]))
    expect(usageReadable(new Set(LEGACY_USAGE_WINDOW_KINDS), reading)).toBe(true)
  })

  it('keeps negative balances reported by a provider', () => {
    expect(UsageBalance.parse({ ...balance, total: -0.25, toppedUp: -2.75 })).toMatchObject({ total: -0.25, toppedUp: -2.75 })
  })

  it.each(['total', 'granted', 'toppedUp'] as const)('rejects non-finite %s amounts', (field) => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(UsageBalance.safeParse({ ...balance, [field]: amount }).success).toBe(false)
    }
  })
})

describe('usageLevel', () => {
  it('warns from 60% and turns critical from 80%', () => {
    expect([0, 59.9, 60, 79.9, 80, 100].map(usageLevel)).toEqual([
      'normal',
      'normal',
      'warning',
      'warning',
      'critical',
      'critical'
    ])
  })
})

describe('tightestWindow', () => {
  it('picks the window closest to its cap', () => {
    expect(tightestWindow([window(10), window(75), window(30)])?.usedPercent).toBe(75)
    expect(tightestWindow([])).toBeNull()
  })
})

describe('quotaVerdict', () => {
  it('knows nothing without a reading or a sign-in', () => {
    expect(quotaVerdict(undefined, NOW)).toEqual({ state: 'unknown', window: null, stale: false })
    expect(quotaVerdict(usage([], { status: 'signed-out' }), NOW).state).toBe('unknown')
    expect(quotaVerdict(usage([]), NOW).state).toBe('unknown')
  })

  it('does not judge agent quota from provider balances, even when one is exhausted', () => {
    const balances = [balance, { ...balance, id: 'empty-provider', total: -0.25, available: false }]
    expect(quotaVerdict(usage([], { balances }), NOW)).toEqual({ state: 'unknown', window: null, stale: false })
    expect(quotaVerdict(usage([window(20)], { balances }), NOW).state).toBe('ok')
  })

  it('goes by the tightest window: tight from 80%, exhausted at the cap', () => {
    const session = window(85, { kind: 'session', windowMinutes: 300 })
    expect(quotaVerdict(usage([window(20), session]), NOW)).toEqual({ state: 'tight', window: session, stale: false })
    expect(quotaVerdict(usage([window(100), session]), NOW).state).toBe('exhausted')
    expect(quotaVerdict(usage([window(79)]), NOW).state).toBe('ok')
  })

  it('skips a window that has reset since it was read', () => {
    const reset = window(100, { resetsAt: NOW - 1 })
    expect(quotaVerdict(usage([reset, window(10)]), NOW)).toMatchObject({ state: 'ok', window: { usedPercent: 10 } })
    expect(quotaVerdict(usage([reset]), NOW)).toEqual({ state: 'ok', window: null, stale: false })
  })

  it('counts a model-specific window only for the model it names', () => {
    const reading = usage([window(30), window(100, { model: 'Opus' })])
    expect(quotaVerdict(reading, NOW, 'opus Opus 5.5').state).toBe('exhausted')
    expect(quotaVerdict(reading, NOW, 'sonnet Sonnet 5').state).toBe('ok')
    expect(quotaVerdict(reading, NOW).state).toBe('ok')
  })

  it('flags numbers that failed to refresh or are old', () => {
    expect(quotaVerdict(usage([window(10)], { status: 'error' }), NOW).stale).toBe(true)
    expect(quotaVerdict(usage([window(10)], { updatedAt: NOW - QUOTA_STALE_MS - 1 }), NOW).stale).toBe(true)
    expect(quotaVerdict(usage([window(10)], { updatedAt: NOW - QUOTA_STALE_MS }), NOW).stale).toBe(false)
  })
})

describe('usageReadable', () => {
  it('holds a reading back from a client that does not know one of its window kinds', () => {
    const legacy = new Set(LEGACY_USAGE_WINDOW_KINDS)
    expect(usageReadable(legacy, usage([window(10), window(20, { kind: 'session' })]))).toBe(true)
    expect(usageReadable(legacy, usage([window(10, { kind: 'monthly' })], { agent: 'cursor' }))).toBe(false)
    expect(usageReadable(new Set(['session', 'weekly', 'monthly']), usage([window(10, { kind: 'monthly' })], { agent: 'cursor' }))).toBe(true)
    expect(usageReadable(legacy, usage([], { agent: 'cursor', status: 'signed-out' }))).toBe(true)
    const gemini = usage([window(25, { kind: 'daily', model: 'gemini-2.5-pro' })], { agent: 'gemini' })
    expect(usageReadable(new Set(['session', 'weekly', 'monthly']), gemini)).toBe(false)
    expect(usageReadable(new Set(['session', 'weekly', 'monthly', 'daily']), gemini)).toBe(true)
  })
})
