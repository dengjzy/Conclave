import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentUsage, ResetCredits } from '@conclave/protocol'
import { ResetCreditList } from './UsageBar'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

const now = Date.parse('2026-10-17T12:00:00Z')
const credit = (id: string, days: number) => ({ id, expiresAt: now + days * 86_400_000, label: 'Full reset (Weekly + 5 hr)', clears: ['session' as const, 'weekly' as const] })
const credits: ResetCredits = { available: 2, credits: [credit('first', 5), credit('second', 12)], blockedBy: null, usable: true }
const usage: AgentUsage = {
  agent: 'codex',
  status: 'ok',
  windows: [{ kind: 'weekly', model: null, usedPercent: 100, windowMinutes: 10_080, resetsAt: null }],
  plan: null,
  error: null,
  updatedAt: now,
  resetCredits: credits
}
const render = (props: Partial<Parameters<typeof ResetCreditList>[0]> = {}) =>
  renderToStaticMarkup(createElement(ResetCreditList, { usage, credits, now, spending: null, onSpend: () => {}, onChange: () => {}, ...props }))

describe('ResetCreditList', () => {
  it('offers each credit the service names on its own, by title and expiry', () => {
    const html = render()
    expect(html.match(/>使用</g)).toHaveLength(2)
    expect(html.match(/Full reset \(Weekly \+ 5 hr\)/g)).toHaveLength(2)
    expect(html).not.toContain('使用一张重置卡')
    expect(html).not.toContain('在 Codex 的用量设置里使用')
  })

  it('asks under the credit picked, and holds the others back meanwhile', () => {
    const html = render({ spending: { phase: 'confirm', creditId: 'second' } })
    expect(html).toContain('用掉一张，立即清零 5h 和每周额度，用掉后不能退回。')
    expect(html).toContain('确认使用')
    // The first credit's button stays, disabled; the second's makes way for the question.
    expect(html.match(/<button[^>]*disabled=""[^>]*>使用</g)).toHaveLength(1)
    expect(html.indexOf('确认使用')).toBeGreaterThan(html.lastIndexOf('Full reset'))
  })

  it("leaves spending to the agent's own app when core cannot", () => {
    const html = render({ credits: { ...credits, usable: false } })
    expect(html).not.toContain('>使用<')
    expect(html).toContain('在 Codex 的用量设置里使用')
  })

  it('spends whichever the service picks when it names none', () => {
    const html = render({ credits: { available: 1, credits: [], blockedBy: null, usable: true } })
    expect(html).toContain('使用一张重置卡')
  })
})
