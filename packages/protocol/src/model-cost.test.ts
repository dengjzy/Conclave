import { describe, expect, it } from 'vitest'
import { agentDescriptor, modelPrice } from './agents'
import { tokenCost, type ModelTokens } from './model-cost'
import { DashboardParams, DashboardStats } from './dashboard'
import { ChatItem } from './chat'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const usage = (fields: Partial<ModelTokens> = {}): ModelTokens => ({
  model: 'claude-haiku-4-5', input: 1_000_000, output: 10_000, cacheRead: 600_000,
  cacheWrite: 200_000, cacheWrite1h: 100_000, costUsd: null, ...fields
})
const price = (agent: 'claude' | 'codex' | 'cursor', model: string, at = NOW) => {
  const result = modelPrice(agentDescriptor(agent).prices, model, at)
  if (!result) throw new Error(`missing ${model}`)
  return result
}

describe('model prices', () => {
  it('matches dated provider versions, leaving aliases and unrecognized variants unknown', () => {
    expect(price('claude', 'claude-haiku-4-5-20251001').model).toBe('claude-haiku-4-5')
    expect(price('codex', 'gpt-6-sol-2026-09-21').model).toBe('gpt-6-sol')
    for (const model of ['haiku', 'opus', 'auto', 'claude-haiku-9-1', 'gpt-6-sol-fast']) {
      expect(modelPrice(agentDescriptor('cursor').prices, model, NOW)).toBeNull()
    }
  })

  it('prices ordinary input, cache reads, 5-minute writes, 1-hour writes and output once each', () => {
    expect(tokenCost(usage(), price('claude', 'claude-haiku-4-5'))).toBeCloseTo(0.2 + 0.06 + 0.125 + 0.2 + 0.05)
    expect(tokenCost(usage({ cacheRead: null }), price('claude', 'claude-haiku-4-5'))).toBeNull()
    expect(tokenCost(usage({ cacheWrite1h: null }), price('claude', 'claude-haiku-4-5'))).toBeNull()
    expect(tokenCost(usage({ cacheRead: 900_000 }), price('claude', 'claude-haiku-4-5'))).toBeNull()
  })

  it('uses actual request lengths rather than cumulative turn input for context tiers', () => {
    const luna = price('codex', 'gpt-6-luna')
    expect(tokenCost(usage({ input: 600_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, requestInputs: [200_000, 200_000, 200_000] }), luna)).toBeCloseTo(0.06)
    expect(tokenCost(usage({ input: 600_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 }), luna)).toBeNull()
    expect(tokenCost(usage({ input: 600_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, requestInputs: [100_000, 500_000] }), luna)).toBeNull()
    expect(tokenCost(usage({ input: 10_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 }), luna, 600_000)).toBeCloseTo(0.002)
  })

  it('applies announced price dates and leaves captured older rates untouched', () => {
    const before = price('cursor', 'gemini-3.8-flash')
    const after = price('cursor', 'gemini-3.8-flash', Date.parse('2027-01-01'))
    expect(before.rates.input).toBe(0.75)
    expect(after.rates.input).toBe(1.5)
    expect(before.rates.input).toBe(0.75)
    expect(modelPrice(agentDescriptor('claude').prices, 'claude-haiku-4-5', NOW - 86_400_000)).toBeNull()
  })

  it('keeps old dashboard requests, reports and chat turns readable', () => {
    expect(DashboardParams.parse({ range: 7, timeZone: 'Asia/Shanghai' })).toEqual({ range: 7, timeZone: 'Asia/Shanghai' })
    const totals = { runs: 0, decided: 0, accepted: 0, medianRunMs: null, turns: 0, failedTurns: 0, interruptedTurns: 0, tokens: 0 }
    expect(DashboardStats.parse({ days: [], current: totals, previous: totals, models: [] }).smallModels).toBeUndefined()
    const turn = ChatItem.parse({ id: 'turn', stageId: 'stage', revision: 1, at: 1, kind: 'turn', state: 'completed', error: null, durationMs: 1000 })
    expect(turn.kind === 'turn' ? turn.smallModelCost : null).toBeUndefined()
  })
})
