import { describe, expect, it } from 'vitest'
import { forecastUsage } from './usage-analytics'
import type { AgentUsage } from './usage'
import { windowPace } from './quota-pace'

const now = Date.parse('2026-10-22T12:00:00Z')
const window = { kind: 'session' as const, model: null, usedPercent: 60, windowMinutes: 300, resetsAt: now + 2 * 3600_000 }
const usage: AgentUsage = { agent: 'codex', account: 'work', status: 'ok', windows: [window], updatedAt: now, plan: null, error: null, resetCredits: null }
const samples = [40, 50, 60].map((used, index) => ({ used, at: now - (2 - index) * 15 * 60_000, reset: window.resetsAt }))

describe('quota forecasts', () => {
  it('uses observed growth instead of lifetime average and compares it with the reset', () => {
    expect(forecastUsage(usage, window, samples, now)).toMatchObject({ basis: 'recent', account: 'work', percentPerHour: 40, runsOutAt: now + 3600_000, beforeReset: true })
    expect(forecastUsage(usage, { ...window, usedPercent: 10 }, samples.map((entry) => ({ ...entry, used: entry.used / 6 })), now).beforeReset).toBe(false)
  })
  it('does not invent an exhaustion time from a flat or stale reading', () => {
    expect(forecastUsage(usage, window, samples.map((entry) => ({ ...entry, used: 60 })), now)).toMatchObject({ basis: 'idle', runsOutAt: null })
    expect(forecastUsage({ ...usage, status: 'error' }, window, samples, now)).toMatchObject({ basis: 'stale', runsOutAt: null })
  })
  it('does not mix generations or future readings, and labels its fallback', () => {
    expect(forecastUsage(usage, window, samples.map((entry) => ({ ...entry, reset: now })), now).basis).toBe('window')
    expect(forecastUsage(usage, { ...window, resetsAt: now + 299 * 60_000, usedPercent: 1 }, [], now).basis).toBe('insufficient')
    expect(forecastUsage(usage, { ...window, resetsAt: now - 1 }, samples, now).basis).toBe('stale')
  })
  it('uses the same fresh observed rate for quota advice and falls back when it grows stale', () => {
    const measured = { ...window, recentRate: { percentPerHour: 40, measuredAt: now } }
    expect(windowPace(measured, now)).toMatchObject({ pace: 'over', runsOutAt: now + 3600_000 })
    expect(windowPace({ ...measured, recentRate: { percentPerHour: 0, measuredAt: now } }, now)).toMatchObject({ projected: 60 })
    expect(windowPace({ ...measured, recentRate: { percentPerHour: 40, measuredAt: now - 31 * 60_000 } }, now)?.pace).toBe('even')
  })
})
