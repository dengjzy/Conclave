import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentUsage } from '@conclave/protocol'
import { SettingsQuotaReadout } from './SettingsQuotaReadout'

const preference = vi.hoisted(() => ({ remaining: false }))
vi.mock('../preferences', () => ({ usePreferences: (select: (state: { usageDisplay: 'used' | 'remaining' }) => unknown) => select({ usageDisplay: preference.remaining ? 'remaining' : 'used' }) }))
const now = 1_800_000_000_000
const usage: AgentUsage = { agent: 'codex', status: 'ok', plan: 'team', error: null, updatedAt: now, resetCredits: null,
  windows: [{ kind: 'session', model: null, usedPercent: 90, windowMinutes: 300, resetsAt: now + 3_600_000 }] }
const render = (value?: AgentUsage) => renderToStaticMarkup(createElement(SettingsQuotaReadout, { usage: value }))
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); preference.remaining = false })
afterEach(() => vi.useRealTimers())

describe('settings quota readings', () => {
  it('never presents missing or signed-out readings as zero usage', () => {
    expect(render()).toContain('还没有额度数据')
    expect(render()).not.toContain('<meter')
    expect(render({ ...usage, status: 'signed-out' })).toContain('未登录')
    expect(render({ ...usage, status: 'signed-out' })).not.toContain('<meter')
  })
  it('keeps urgency based on spent quota when the display changes to remaining', () => {
    preference.remaining = true
    const html = render(usage)
    expect(html).toContain('data-level="critical"')
    expect(html).toContain('value="10"')
    expect(html).toContain('剩 10%')
  })
  it('marks retained readings as outdated after a refresh or authentication failure', () => {
    expect(render({ ...usage, status: 'error', error: 'auth-expired' })).toContain('登录已过期')
    expect(render({ ...usage, status: 'error', error: 'network' })).toContain('刷新失败')
    expect(render({ ...usage, status: 'error', error: 'network' })).toContain('<meter')
  })
  it('does not show a spent meter once the window is past its reset time', () => {
    const html = render({ ...usage, windows: [{ kind: 'session', model: null, usedPercent: 90, windowMinutes: 300, resetsAt: now - 1 }] })
    expect(html).toContain('即将重置')
    expect(html).not.toContain('<meter')
  })
  it('shows balance-only readings without the empty-quota hint or a fabricated meter', () => {
    const value: AgentUsage = { ...usage, agent: 'dsh', windows: [], balances: [{ id: 'deepseek', name: 'DeepSeek', currency: 'CNY', total: 0, granted: 0, toppedUp: 0, available: false }] }
    const html = render(value)
    expect(html).toContain('DeepSeek')
    expect(html).toContain('余额 ¥0.00')
    expect(html).toContain('余额不足，暂时无法调用')
    expect(html).not.toContain('还没有额度数据')
    expect(html).not.toContain('<meter')
    expect(render({ ...value, status: 'error', error: 'network' })).toContain('刷新失败')
    expect(render({ ...value, status: 'error', error: 'api-key-rejected' })).toContain('API Key 无效或已失效，请检查服务商或智能体中的 Key')
    expect(render({ ...value, updatedAt: now - 31 * 60_000 })).toContain('可能已过时')
  })
})
