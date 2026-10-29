import { expect, it } from 'vitest'
import type { AgentAccount, AgentAccounts } from '@conclave/protocol'
import { accountName, shownAccountName } from './agent-accounts'

const account = (id: string, changes: Partial<AgentAccount> = {}): AgentAccount => ({
  id, agent: 'claude', label: null, email: null, plan: null, signedIn: true, createdAt: 0, ...changes
})

it('names an account by the user’s name for it, then who signed in, then which it is', () => {
  expect(accountName(account('a', { label: '工作', email: 'me@work.com' }))).toBe('工作')
  expect(accountName(account('a', { email: 'me@work.com' }))).toBe('me@work.com')
  expect(accountName(account('default'))).toBe('本机账号')
  expect(accountName(account('3f2a'))).toBe('账号 3f2a')
})

it('shows an account’s name only where the agent has more than one', () => {
  const one: AgentAccounts = { accounts: [account('default'), account('x', { agent: 'codex' })], active: {}, autoSwitch: true }
  const two: AgentAccounts = { ...one, accounts: [...one.accounts, account('work', { label: '工作' })] }
  expect(shownAccountName(one, 'claude', 'default')).toBeNull()
  expect(shownAccountName(two, 'claude', 'work')).toBe('工作')
  expect(shownAccountName(two, 'claude', null)).toBeNull()
})
