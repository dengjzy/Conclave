import { describe, expect, it } from 'vitest'
import { activeUsage, pickAccount, type AgentAccount } from './agent-account'
import type { AgentUsage } from './usage'

const NOW = 1_790_000_000_000

const account = (id: string, changes: Partial<AgentAccount> = {}): AgentAccount => ({
  id, agent: 'claude', label: null, email: null, plan: null, signedIn: true, createdAt: 0, ...changes
})

const usage = (id: string | undefined, usedPercent: number, resetsAt: number | null = NOW + 60_000): AgentUsage => ({
  agent: 'claude', account: id, status: 'ok', plan: null, error: null, updatedAt: NOW, resetCredits: null,
  windows: [{ kind: 'session', model: null, usedPercent, windowMinutes: 300, resetsAt }]
})

describe('pickAccount', () => {
  it('moves to the least used account with room, never the one that ran out', () => {
    const accounts = [account('default'), account('a'), account('b')]
    expect(pickAccount(accounts, [usage(undefined, 100), usage('a', 50), usage('b', 10)], 'claude', 'default', NOW)?.id).toBe('b')
  })

  it('takes a reading near its cap before one without a reading, and skips spent and signed-out accounts', () => {
    const accounts = [account('a'), account('b'), account('c', { signedIn: false }), account('d')]
    const list = [usage('a', 85), usage('d', 100)]
    expect(pickAccount(accounts, list, 'claude', null, NOW)?.id).toBe('a')
    expect(pickAccount(accounts, list, 'claude', 'a', NOW)?.id).toBe('b')
    expect(pickAccount(accounts, list, 'claude', 'b', NOW)?.id).toBe('a')
  })

  it('counts a window past its reset as having room again', () => {
    expect(pickAccount([account('a')], [usage('a', 100, NOW - 1)], 'claude', null, NOW)?.id).toBe('a')
  })

  it('finds none when every other account is spent, or of another agent', () => {
    const accounts = [account('default'), account('a'), account('x', { agent: 'codex' })]
    expect(pickAccount(accounts, [usage('a', 100)], 'claude', 'default', NOW)).toBeNull()
  })
})

describe('activeUsage', () => {
  it('reads the active account, an unnamed reading being the default one', () => {
    const list = [usage(undefined, 10), usage('a', 70)]
    expect(activeUsage(list, { active: {} }, 'claude')?.windows[0]?.usedPercent).toBe(10)
    expect(activeUsage(list, { active: { claude: 'a' } }, 'claude')?.windows[0]?.usedPercent).toBe(70)
  })
})
