import { describe, expect, it } from 'vitest'
import type { AgentUsage, QuotaAdvice, UsageWindow } from '@conclave/protocol'
import { adviceText, alternativeAgent, spacedText } from './quota-advice-text'
import { formatClock } from './usage-format'

const NOW = 1_790_000_000_000
const HOUR = 3_600_000

const window = (kind: UsageWindow['kind'], usedPercent: number, resetsAt: number, model: string | null = null): UsageWindow => ({
  kind,
  model,
  usedPercent,
  windowMinutes: kind === 'session' ? 300 : 10_080,
  resetsAt
})

const advice = (fields: Partial<QuotaAdvice> & Pick<QuotaAdvice, 'kind' | 'window'>): QuotaAdvice => ({ agent: 'claude', at: null, percent: null, model: null, ...fields })

const usage = (agent: AgentUsage['agent'], windows: UsageWindow[]): AgentUsage => ({ agent, status: 'ok', windows, plan: null, error: null, updatedAt: NOW, resetCredits: null })

describe('spacedText', () => {
  it('sets Latin letters and digits off from Han characters', () => {
    expect(spacedText('Opus 本周额度已用85%：换Sonnet')).toBe('Opus 本周额度已用 85%：换 Sonnet')
    expect(spacedText('5h额度')).toBe('5h 额度')
  })
})

describe('adviceText', () => {
  const resetsAt = NOW + 20 * HOUR

  it('says how much of a week would go unused, and the model to spend it on', () => {
    const text = adviceText(advice({ kind: 'use-more', window: window('weekly', 45, resetsAt), percent: 40.4, at: resetsAt, model: 'Opus' }), NOW, null)
    expect(text).toBe(`本周还剩 55%，${formatClock(resetsAt, NOW)} 重置，照现在的速度约 40% 会用不上：适合现在跑大任务或并行任务，也可以放心用 Opus`)
  })

  it('says when a week runs out and who takes light work meanwhile', () => {
    const at = NOW + 2 * HOUR
    const text = adviceText(advice({ kind: 'slow-down', window: window('weekly', 80, NOW + 26 * HOUR), at }), NOW, 'codex')
    expect(text).toBe(`照现在的速度本周额度会在 ${formatClock(at, NOW)} 用完，比重置早 1 天：轻活可以交给 Codex`)
  })

  it('says when the 5-hour window resets, and to spare a model near its cap', () => {
    expect(adviceText(advice({ kind: 'wait-reset', window: window('session', 100, NOW + HOUR) }), NOW, null)).toBe(
      `5h 额度已用完，${formatClock(NOW + HOUR, NOW)} 重置；大任务可以等重置后再开`
    )
    expect(adviceText(advice({ kind: 'switch-model', window: window('weekly', 85, resetsAt, 'Opus'), model: 'Opus' }), NOW, null)).toBe(
      'Opus 本周已用 85%：日常改动可以换其他模型，把 Opus 留给难题'
    )
  })
})

describe('alternativeAgent', () => {
  it('names another agent only while it has room and is on pace', () => {
    const claude = usage('claude', [window('weekly', 80, NOW + 4 * 24 * HOUR)])
    expect(alternativeAgent('claude', [claude, usage('codex', [window('weekly', 20, NOW + 3 * 24 * HOUR)])], ['claude', 'codex'], NOW)).toBe('codex')
    expect(alternativeAgent('claude', [claude, usage('codex', [window('weekly', 90, NOW + 3 * 24 * HOUR)])], ['claude', 'codex'], NOW)).toBeNull()
    expect(alternativeAgent('claude', [claude], ['claude'], NOW)).toBeNull()
  })
})
