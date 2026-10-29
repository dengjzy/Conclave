import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { SmallModelCost, SmallModelStats } from '@conclave/protocol'
import { coverage, dollars, headlineDollars, smallModelExplanation, tickDollars } from './model-cost-format'
import { SmallModelStats as Breakdown } from './components/SmallModelStats'
import { dayTokens, activity } from './dashboard-model'

const cost: SmallModelCost = {
  costUsd: 0.005, savedUsd: 0.01, modelDifferenceUsd: -0.02, contextSavedUsd: 0.03,
  baseline: { model: 'main-model', context: 600_000, price: null },
  calls: 1, callsEstimated: true, prices: [], completed: true
}
const totals = { count: 2, tokens: 1000, measured: 1, priced: 1, estimated: 1, costUsd: 0.005, savedUsd: 0.01 }

describe('small-model display', () => {
  it('distinguishes missing, zero and small nonzero amounts', () => {
    expect(dollars(null)).toBe('—')
    expect(dollars(0)).toBe('$0.00')
    expect(dollars(0.00001)).toBe('<$0.01')
    expect(dollars(0.01)).toBe('$0.01')
    expect(dollars(1209.906)).toBe('$1,209.91')
  })

  it('drops the cents from a headline or an axis once they no longer matter', () => {
    expect(headlineDollars(1209.906)).toBe('$1,210')
    expect(headlineDollars(91.8)).toBe('$91.80')
    expect(tickDollars(85.25, 341)).toBe('$85')
    expect(tickDollars(2.5, 5)).toBe('$2.50')
  })

  it('explains the baseline, both components, flooring and conservative assumptions', () => {
    const text = smallModelExplanation(cost)
    for (const piece of ['按 API 标价折算', 'main-model', '600000 token', '$-0.020000', 'max(0', '不计负值', '缓存仍热', '以后留在主上下文', '保守估算']) expect(text).toContain(piece)
    expect(smallModelExplanation({ ...cost, completed: false, savedUsd: null })).toContain('失败或中断')
  })

  it('shows amount coverage and unavailable Cursor usage rather than zero tokens', () => {
    const stats: SmallModelStats = { current: totals, previous: totals, kinds: [
      { ...totals, kind: 'translation' },
      { count: 1, measured: 0, tokens: 0, priced: 0, estimated: 0, costUsd: null, savedUsd: null, kind: 'helper' }
    ] }
    const html = renderToStaticMarkup(createElement(Breakdown, { stats }))
    expect(html).toContain('可计价 1 次')
    expect(html).toContain('可估算 1 次')
    expect(html).toContain('未提供')
    expect(html).toContain('Cursor 小助手')
    expect(coverage(totals)).toContain('共 2 次')
  })

  it('includes one-off work in daily totals and activity without inventing chat turns', () => {
    const day = { day: '2026-10-14', runs: 0, accepted: 0, turns: 0, runTokens: 0, turnTokens: 0, quickTokens: 100, quickRequests: 1 }
    expect(dayTokens(day)).toBe(100)
    expect(activity(day)).toBe(1)
  })
})
