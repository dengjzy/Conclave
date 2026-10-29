import { describe, expect, it } from 'vitest'
import type { UsageHistory, UsageTotals } from '@conclave/protocol'
import { agentGraph, agentShares, cacheHit, tokenParts } from './usage-report'

const totals = (input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number | null = null): UsageTotals =>
  ({ requests: 1, input, output, cacheRead, cacheWrite, costUsd, reportedUsd: null, estimatedUsd: costUsd, priced: costUsd === null ? 0 : 1 })
const model = (agent: UsageHistory['models'][number]['agent'], name: string, tokens: number, costUsd: number | null): UsageHistory['models'][number] =>
  ({ ...totals(tokens, 0, 0, 0, costUsd), agent, model: name })

describe('usage report', () => {
  it('splits the tokens into cache reads, cache writes, the rest of the input and the output', () => {
    expect(tokenParts(totals(1000, 50, 900, 60))).toEqual({ cacheRead: 900, cacheWrite: 60, fresh: 40, output: 50 })
    expect(cacheHit(totals(1000, 50, 900, 60))).toBe(0.9)
    expect(cacheHit(totals(0, 0, 0, 0))).toBeNull()
  })

  it('adds each agent up, busiest first, with a cost only when one of its models was priced', () => {
    expect(agentShares([model('codex', 'a', 10, 1), model('claude', 'b', 30, null), model('codex', 'c', 5, 2), model('claude', 'd', 1, null)])).toEqual([
      { agent: 'claude', tokens: 31, costUsd: null },
      { agent: 'codex', tokens: 15, costUsd: 3 }
    ])
  })

  it('keeps an agent in one colour however the page is narrowed', () => {
    expect(agentGraph('claude')).toBe(1)
    expect(agentGraph('codex')).toBe(2)
    expect(agentGraph('antigravity')).toBe(1)
  })
})
