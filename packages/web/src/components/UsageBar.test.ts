import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type { AgentKind, AgentUsage, UsageBalance } from '@conclave/protocol'
import { useCore } from '../core-store'
import { DEFAULT_PREFERENCES, usePreferences } from '../preferences'
import { setLocale } from '../i18n'
import { UsageBar, UsageCard } from './UsageBar'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

const reading = (agent: AgentKind, status: AgentUsage['status'] = 'ok'): AgentUsage => ({ agent, status, plan: null, error: null, updatedAt: Date.now(), resetCredits: null, windows: [] })
const render = () => renderToStaticMarkup(createElement(UsageBar))
const balance = (changes: Partial<UsageBalance> = {}): UsageBalance => ({ id: 'deepseek', name: 'DeepSeek', currency: 'CNY', total: 15.25, granted: 5, toppedUp: 10.25, available: true, ...changes })
const renderCard = (usage: AgentUsage, refreshing = false) => renderToStaticMarkup(createElement(UsageCard, {
  usage, accounts: [], accountLabel: null, now: Date.now(), advice: [], alternative: null, showPace: false,
  anchor: { x: 20, y: 760, width: 100, height: 24, top: 760, bottom: 784, left: 20, right: 120, toJSON: () => ({}) },
  id: 'balance-card', cardRef: createRef<HTMLDivElement>(), onEnter() {}, onLeave() {}, onRefresh() {},
  refreshing, spending: null, onSpend() {}, onSpendingChange() {}
}))

beforeEach(() => {
  useCore.setState({ ...useCore.getInitialState(), usage: { claude: reading('claude'), codex: reading('codex') } }, true)
  usePreferences.setState({ ...DEFAULT_PREFERENCES, quotaAdvice: false }, true)
  setLocale('zh-CN')
})
afterEach(() => setLocale('zh-CN'))

describe('status bar usage visibility', () => {
  it('shows every reported Agent by default and hides only the selected one', () => {
    expect(render()).toContain('aria-label="Claude Code"')
    expect(render()).toContain('aria-label="Codex"')
    const usage = useCore.getState().usage
    usePreferences.setState({ hiddenUsageAgents: ['claude'] })
    expect(render()).not.toContain('Claude Code')
    expect(render()).toContain('aria-label="Codex"')
    expect(useCore.getState().usage).toBe(usage)
  })

  it('renders nothing when every reported Agent is hidden, without a sign-in warning', () => {
    usePreferences.setState({ hiddenUsageAgents: ['claude', 'codex'] })
    expect(render()).toBe('')
  })

  it('keeps individual choices when the main switch is turned off and back on', () => {
    usePreferences.setState({ showUsage: false, hiddenUsageAgents: ['claude'] })
    expect(render()).toBe('')
    usePreferences.setState({ showUsage: true })
    expect(render()).not.toContain('Claude Code')
    expect(render()).toContain('aria-label="Codex"')
  })

  it('only names visible Agents in a sign-in hint', () => {
    useCore.setState({ usage: { claude: reading('claude', 'signed-out'), codex: reading('codex', 'signed-out') } })
    usePreferences.setState({ hiddenUsageAgents: ['claude'] })
    expect(render()).toContain('未检测到 Codex 的登录')
    expect(render()).not.toContain('Claude Code')
  })
})

describe('monetary balances', () => {
  it('shows a zero balance and the provider availability warning without inventing a percentage', () => {
    useCore.setState({ usage: { dsh: { ...reading('dsh'), balances: [balance({ total: 0, granted: 0, toppedUp: 0, available: false })] } } })
    const html = render()
    expect(html).toContain('余额 ¥0.00')
    expect(html).toContain('aria-label="余额不足，暂时无法调用"')
    expect(html).not.toContain('usage-meter')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('%')
  })

  it('keeps each source and currency separate alongside existing quota windows', () => {
    useCore.setState({ usage: { dsh: { ...reading('dsh'),
      windows: [{ kind: 'session', model: null, usedPercent: 20, windowMinutes: 300, resetsAt: null }],
      balances: [balance(), balance({ id: 'international', name: 'International', currency: 'USD', total: 0.0012 })]
    } } })
    const html = render()
    expect(html).toContain('DeepSeek 余额 ¥15.25')
    expect(html).toContain('International 余额 $0.0012')
    expect(html).toContain('5h 20%')
    expect(html.match(/class="usage-balance"/g)).toHaveLength(2)
    usePreferences.setState({ usageDisplay: 'remaining' })
    expect(render()).toContain('5h 剩 80%')
    expect(render()).toContain('DeepSeek 余额 ¥15.25')
  })

  it('retains the last balance and its timestamp when refresh fails', () => {
    const usage = { ...reading('dsh', 'error'), error: 'network', balances: [balance()], updatedAt: Date.now() - 60_000 }
    useCore.setState({ usage: { dsh: usage } })
    expect(render()).toContain('data-stale="true"')
    expect(render()).toContain('余额 ¥15.25')
    const card = renderCard(usage)
    expect(card).toContain('读取失败，稍后自动重试')
    expect(card).toContain('数据停留在')
    expect(card).toContain('立即刷新')
  })

  it('points rejected API keys to provider or agent settings instead of suggesting a CLI refresh', () => {
    const usage = { ...reading('dsh', 'error'), error: 'api-key-rejected', balances: [balance()] }
    useCore.setState({ usage: { dsh: usage } })
    expect(render()).toContain('API Key 无效或已失效，请检查服务商或智能体中的 Key')
    const card = renderCard(usage)
    expect(card).toContain('API Key 无效或已失效，请检查服务商或智能体中的 Key')
    expect(card).not.toContain('运行一次')
    setLocale('en')
    expect(renderCard(usage)).toContain('Check the key in your provider or agent settings.')
  })

  it('shows source, currency, granted and topped-up balances in the card', () => {
    const card = renderCard({ ...reading('dsh'), balances: [balance(), balance({ id: 'empty', name: 'Empty', currency: 'USD', total: 0, granted: 0, toppedUp: 0, available: false })] })
    expect(card).toContain('DeepSeek (CNY)')
    expect(card).toContain('余额 ¥15.25')
    expect(card).toContain('赠送 ¥5.00')
    expect(card).toContain('充值 ¥10.25')
    expect(card).toContain('Empty (USD)')
    expect(card).toContain('余额 $0.00')
    expect(card).toContain('余额不足，暂时无法调用')
    expect(card).not.toContain('usage-meter')
  })

  it('localizes balance details and preserves the refresh-in-progress state', () => {
    setLocale('en')
    const card = renderCard({ ...reading('dsh'), balances: [balance()] }, true)
    expect(card).toContain('¥15.25 remaining')
    expect(card).toContain('Granted ¥5.00')
    expect(card).toContain('Topped up ¥10.25')
    expect(card).toContain('disabled="">Refreshing…')
  })

  it('falls back to model-grouped windows in both the status bar and account switcher when no general window exists', () => {
    const modelOnly: AgentUsage = {
      ...reading('antigravity'),
      account: 'default',
      windows: [{ kind: 'weekly', model: 'Claude and GPT models', usedPercent: 15, windowMinutes: 10_080, resetsAt: null }]
    }
    const ownOnly: AgentUsage = {
      ...reading('antigravity'),
      account: 'own',
      windows: [{ kind: 'weekly', model: 'Claude and GPT models', usedPercent: 5, windowMinutes: 10_080, resetsAt: null }]
    }
    useCore.setState({ usage: { antigravity: modelOnly }, accountUsage: [modelOnly, ownOnly] })
    expect(render()).toContain('Claude and GPT models 本周 15%')

    const accounts = [
      { id: 'default', agent: 'antigravity' as const, label: null, email: 'a@example.com', plan: null, createdAt: 0, signedIn: true },
      { id: 'own', agent: 'antigravity' as const, label: 'own', email: 'b@example.com', plan: null, createdAt: 1, signedIn: true }
    ]
    const card = renderToStaticMarkup(createElement(UsageCard, {
      usage: modelOnly, accounts, accountLabel: 'a@example.com', now: Date.now(), advice: [], alternative: null, showPace: false,
      anchor: { x: 20, y: 760, width: 100, height: 24, top: 760, bottom: 784, left: 20, right: 120, toJSON: () => ({}) },
      id: 'model-only-card', cardRef: createRef<HTMLDivElement>(), onEnter() {}, onLeave() {}, onRefresh() {},
      refreshing: false, spending: null, onSpend() {}, onSpendingChange() {}
    }))
    expect(card).toContain('Claude and GPT models 本周 15%')
    expect(card).toContain('Claude and GPT models 本周 5%')
    expect(card).not.toContain('还没有额度数据')
  })
})
