import { t } from './i18n'
import { DEFAULT_ACCOUNT, type AgentAccount, type AgentAccounts, type AgentKind } from '@conclave/protocol'

// What the user calls an account: their name for it, else who signed in, else which it is.
export function accountName(account: Pick<AgentAccount, 'id' | 'label' | 'email'>): string {
  return account.label || account.email || (account.id === DEFAULT_ACCOUNT ? t('AgentAccounts.own') : t('AgentAccounts.unnamed', { value1: account.id }))
}

export function accountsOf(accounts: AgentAccounts | null, agent: AgentKind): AgentAccount[] {
  return accounts?.accounts.filter((account) => account.agent === agent) ?? []
}

// An account's name where the agent has more than one to tell apart; null where it has just one.
export function shownAccountName(accounts: AgentAccounts | null, agent: AgentKind, id: string | null | undefined): string | null {
  const own = accountsOf(accounts, agent)
  const account = own.length > 1 && id ? own.find((each) => each.id === id) : undefined
  return account ? accountName(account) : null
}
