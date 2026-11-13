import { describe, expect, it } from 'vitest'
import type { AgentAccounts, Environment } from '@conclave/protocol'
import { agentCatalogScope } from './agent-models'
import { catalogKey } from './model-provider-choice'

const environment = (overrides: Partial<Environment['checks'][number]> = {}): Environment => ({
  checks: [{
    tool: 'antigravity',
    status: 'ok',
    version: '1.5.6',
    path: '/home/user/.local/bin/agy',
    signedIn: false,
    ...overrides
  }],
  checkedAt: 0,
  searchPath: []
})

const accounts = (activeId: string, signedIn: boolean): AgentAccounts => ({
  accounts: [{ id: activeId, agent: 'antigravity', label: activeId, email: null, plan: null, signedIn, createdAt: 0 }],
  active: { antigravity: activeId },
  autoSwitch: false
})

describe('agentCatalogScope', () => {
  it('changes catalogKey when active account, sign-in state, or CLI version/path changes', () => {
    const initial = catalogKey('antigravity', null, agentCatalogScope('antigravity', accounts('default', false), environment()))
    const signedIn = catalogKey('antigravity', null, agentCatalogScope('antigravity', accounts('default', true), environment()))
    const switchedAccount = catalogKey('antigravity', null, agentCatalogScope('antigravity', accounts('own', true), environment()))
    const upgradedCli = catalogKey('antigravity', null, agentCatalogScope('antigravity', accounts('own', true), environment({ version: '1.6.0' })))
    const movedCli = catalogKey('antigravity', null, agentCatalogScope('antigravity', accounts('own', true), environment({ path: '/usr/local/bin/agy' })))

    expect(new Set([initial, signedIn, switchedAccount, upgradedCli, movedCli]).size).toBe(5)
  })

  it('uses environment check signedIn for default account when account list has not loaded', () => {
    const before = catalogKey('antigravity', null, agentCatalogScope('antigravity', null, environment({ signedIn: false })))
    const after = catalogKey('antigravity', null, agentCatalogScope('antigravity', null, environment({ signedIn: true })))
    expect(before).not.toBe(after)
  })
})
