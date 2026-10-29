import { describe, expect, it } from 'vitest'
import { agentAdvice, rankAgents, recommendAgent, windowPace } from './quota-pace'
import { QUOTA_STALE_MS, type AgentUsage, type UsageWindow } from './usage'

const NOW = 1_790_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

// A window `gone` of the way through, as a share of its length.
const weekly = (usedPercent: number, gone: number, model: string | null = null): UsageWindow => ({
  kind: 'weekly',
  model,
  usedPercent,
  windowMinutes: 10_080,
  resetsAt: NOW + (1 - gone) * 7 * DAY
})

const session = (usedPercent: number, gone: number): UsageWindow => ({
  kind: 'session',
  model: null,
  usedPercent,
  windowMinutes: 300,
  resetsAt: NOW + (1 - gone) * 5 * HOUR
})

const usage = (agent: AgentUsage['agent'], windows: UsageWindow[], extra: Partial<AgentUsage> = {}): AgentUsage => ({
  agent,
  status: 'ok',
  windows,
  plan: null,
  error: null,
  updatedAt: NOW,
  resetCredits: null,
  ...extra
})

describe('windowPace', () => {
  it('says nothing of a window with no reset time or one past it', () => {
    expect(windowPace({ ...weekly(50, 0.5), resetsAt: null }, NOW)).toBeNull()
    expect(windowPace({ ...weekly(50, 0.5), resetsAt: NOW - 1 }, NOW)).toBeNull()
  })

  it('waits for a tenth of the window before judging the rate', () => {
    expect(windowPace(weekly(30, 0.05), NOW)?.pace).toBe('early')
    expect(windowPace(weekly(100, 0.05), NOW)?.pace).toBe('exhausted')
  })

  it('sees a window running out before its reset, and when', () => {
    const pace = windowPace(weekly(60, 0.4), NOW)
    expect(pace?.pace).toBe('over')
    expect(pace?.projected).toBeCloseTo(150)
    // 60% in 2.8 days runs the other 40% out in 1.87 days.
    expect(pace?.runsOutAt).toBeCloseTo(NOW + (40 / 60) * 0.4 * 7 * DAY)
  })

  it('sees one about to reset with much left over, only near its reset', () => {
    const pace = windowPace(weekly(40, 0.85), NOW)
    expect(pace).toMatchObject({ pace: 'under' })
    expect(pace?.wastePercent).toBeCloseTo(100 - 40 / 0.85)
    expect(windowPace(weekly(20, 0.5), NOW)?.pace).toBe('even')
    expect(windowPace(weekly(70, 0.9), NOW)?.pace).toBe('even')
  })
})

describe('agentAdvice', () => {
  it('urges spending a week about to go unused, on the model with room', () => {
    const advice = agentAdvice(usage('claude', [session(10, 0.5), weekly(40, 0.85), weekly(20, 0.85, 'Opus')]), NOW)
    expect(advice).toEqual([expect.objectContaining({ kind: 'use-more', model: 'Opus', at: NOW + 0.15 * 7 * DAY })])
    expect(advice[0]?.percent).toBeCloseTo(100 - 40 / 0.85)
  })

  it('does not urge spending on stale numbers or while the 5-hour window is tight', () => {
    expect(agentAdvice(usage('claude', [weekly(40, 0.85)], { updatedAt: NOW - QUOTA_STALE_MS - 1 }), NOW)).toEqual([])
    expect(agentAdvice(usage('claude', [session(85, 0.5), weekly(40, 0.85)]), NOW).map((item) => item.kind)).toEqual(['wait-reset'])
  })

  it('says to wait for the 5-hour reset, slow down a week, and spare a model near its cap', () => {
    const advice = agentAdvice(usage('claude', [session(100, 0.5), weekly(60, 0.4), weekly(85, 0.4, 'Opus')]), NOW)
    expect(advice.map((item) => item.kind)).toEqual(['wait-reset', 'slow-down', 'switch-model'])
    expect(advice[0]?.at).toBe(NOW + 2.5 * HOUR)
    expect(advice[2]?.model).toBe('Opus')
  })

  it('leaves a used-up week and a signed-out agent to the verdict', () => {
    expect(agentAdvice(usage('claude', [session(100, 0.5), weekly(100, 0.5)]), NOW)).toEqual([])
    expect(agentAdvice(usage('claude', [weekly(40, 0.85)], { status: 'signed-out' }), NOW)).toEqual([])
    expect(agentAdvice(undefined, NOW)).toEqual([])
  })
})

describe('rankAgents', () => {
  it('puts room before none, and quota about to go unused before quota that keeps', () => {
    expect(rankAgents([usage('claude', [weekly(100, 0.5)]), usage('codex', [weekly(50, 0.5)])], ['claude', 'codex'], NOW)).toEqual(['codex', 'claude'])
    expect(rankAgents([usage('claude', [weekly(20, 0.5)]), usage('codex', [weekly(50, 0.9)])], ['claude', 'codex'], NOW)).toEqual(['codex', 'claude'])
    expect(rankAgents([usage('claude', [weekly(20, 0.5)]), usage('codex', [weekly(30, 0.5)])], ['claude', 'codex'], NOW)).toEqual(['claude', 'codex'])
  })

  it('puts one running out early after one on pace', () => {
    expect(rankAgents([usage('claude', [weekly(50, 0.3)]), usage('codex', [weekly(60, 0.6)])], ['claude', 'codex'], NOW)).toEqual(['codex', 'claude'])
  })

  it('takes the one to reset first when all are used up', () => {
    const soon = { ...weekly(100, 0.5), resetsAt: NOW + HOUR }
    expect(rankAgents([usage('claude', [weekly(100, 0.5)]), usage('codex', [soon])], ['claude', 'codex'], NOW)).toEqual(['codex', 'claude'])
  })
})

describe('recommendAgent', () => {
  it('marks one only when it is clearly the better one to use', () => {
    const expiring = usage('codex', [weekly(30, 0.9)])
    expect(recommendAgent([usage('claude', [weekly(20, 0.5)]), expiring], ['claude', 'codex'], NOW)).toEqual({ agent: 'codex', reason: 'expiring' })
    expect(recommendAgent([usage('claude', [weekly(85, 0.7)]), usage('codex', [weekly(30, 0.5)])], ['claude', 'codex'], NOW)).toEqual({ agent: 'codex', reason: 'room' })
    expect(recommendAgent([usage('claude', [weekly(20, 0.5)]), usage('codex', [weekly(30, 0.5)])], ['claude', 'codex'], NOW)).toBeNull()
    expect(recommendAgent([expiring], ['codex'], NOW)).toBeNull()
    expect(recommendAgent([usage('claude', [weekly(100, 0.5)]), usage('codex', [weekly(100, 0.5)])], ['claude', 'codex'], NOW)).toBeNull()
  })
})
