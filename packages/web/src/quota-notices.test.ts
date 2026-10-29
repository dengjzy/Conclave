import { describe, expect, it } from 'vitest'
import type { AgentUsage, UsageWindow } from '@conclave/protocol'
import { quotaNoticesBetween } from './quota-notices'

const NOW = 1_790_000_000_000
const HOUR = 3_600_000

const weekly = (usedPercent: number, resetsIn: number): UsageWindow => ({ kind: 'weekly', model: null, usedPercent, windowMinutes: 10_080, resetsAt: NOW + resetsIn })
const session = (usedPercent: number): UsageWindow => ({ kind: 'session', model: null, usedPercent, windowMinutes: 300, resetsAt: NOW + 2 * HOUR })

const claude = (windows: UsageWindow[]): Partial<Record<'claude', AgentUsage>> => ({
  claude: { agent: 'claude', status: 'ok', windows, plan: null, error: null, updatedAt: NOW, resetCredits: null }
})

describe('quotaNoticesBetween', () => {
  it('tells of a week about to go unused once per cycle, and only near its reset', () => {
    const sent = new Set<string>()
    const next = claude([session(10), weekly(30, 12 * HOUR)])
    expect(quotaNoticesBetween(null, next, NOW, sent, ['claude'])).toEqual([
      expect.objectContaining({ title: 'Claude Code 额度建议', target: { kind: 'usage', agent: 'claude' } })
    ])
    expect(quotaNoticesBetween(next, claude([session(12), weekly(31, 12 * HOUR)]), NOW, sent, ['claude'])).toEqual([])
    // Two days out there is still time to catch up.
    expect(quotaNoticesBetween(null, claude([session(10), weekly(30, 40 * HOUR)]), NOW, new Set(), ['claude'])).toEqual([])
  })

  it('tells of a week running out early', () => {
    const notices = quotaNoticesBetween(null, claude([weekly(70, 4 * 24 * HOUR)]), NOW, new Set(), ['claude'])
    expect(notices.map((notice) => notice.body)).toEqual([expect.stringContaining('照现在的速度本周额度会在')])
  })

  it('tells of a used-up window that has room again', () => {
    const before = claude([session(100), weekly(50, 3 * 24 * HOUR)])
    const after = claude([session(0), weekly(50, 3 * 24 * HOUR)])
    expect(quotaNoticesBetween(before, after, NOW, new Set(), ['claude'])).toEqual([
      { title: 'Claude Code 额度已恢复', body: '5h 额度已重置，可以继续用了', target: { kind: 'usage', agent: 'claude' } }
    ])
  })
})
