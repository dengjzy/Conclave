import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type { AgentKind, AgentUsage } from '@conclave/protocol'
import { useCore } from '../core-store'
import { DEFAULT_PREFERENCES, usePreferences } from '../preferences'
import { UsageBar } from './UsageBar'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
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

beforeEach(() => {
  useCore.setState({ ...useCore.getInitialState(), usage: { claude: reading('claude'), codex: reading('codex') } }, true)
  usePreferences.setState({ ...DEFAULT_PREFERENCES, quotaAdvice: false }, true)
})

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
