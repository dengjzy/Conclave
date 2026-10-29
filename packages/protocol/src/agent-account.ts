import { z } from 'zod'
import { AgentKind } from './agent'
import { agentDescriptor } from './agents'
import { quotaVerdict, type AgentUsage, type QuotaState } from './usage'

// Accounts an agent signs in to (Settings → Agent → 账号): each runs in a config folder of its own,
// which core points the agent's process at. The default account is the user's own folder, as the
// agent finds it without Conclave; it is always there and cannot be removed.

export const DEFAULT_ACCOUNT = 'default'

// Never renamed: a stage keeps the account it ran on, and the folder is named after it.
export const AgentAccountId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
export type AgentAccountId = z.infer<typeof AgentAccountId>

// label: the user's name for it; email and plan: what its sign-in says, where it says.
export const AgentAccount = z.object({
  id: AgentAccountId,
  agent: AgentKind,
  label: z.string().trim().max(60).nullable(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  signedIn: z.boolean(),
  createdAt: z.number()
})
export type AgentAccount = z.infer<typeof AgentAccount>

// active: the account each agent's next process starts on, the default where none is named.
// autoSwitch: a turn that runs into a usage limit moves its agent to the next account with quota.
export const AgentAccounts = z.object({
  accounts: z.array(AgentAccount),
  active: z.partialRecord(AgentKind, AgentAccountId),
  autoSwitch: z.boolean()
})
export type AgentAccounts = z.infer<typeof AgentAccounts>

export function accountsSupported(agent: AgentKind): boolean {
  return agentDescriptor(agent).capabilities.accounts
}

export function activeAccount(state: Pick<AgentAccounts, 'active'> | null | undefined, agent: AgentKind): AgentAccountId {
  return state?.active[agent] ?? DEFAULT_ACCOUNT
}

// A reading's account: an older core's reading, without one, is the default account's.
export function usageAccount(usage: Pick<AgentUsage, 'account'>): AgentAccountId {
  return usage.account ?? DEFAULT_ACCOUNT
}

export function accountUsage(list: readonly AgentUsage[], agent: AgentKind, account: AgentAccountId): AgentUsage | undefined {
  return list.find((usage) => usage.agent === agent && usageAccount(usage) === account)
}

// The reading the agent's next process spends: its active account's.
export function activeUsage(list: readonly AgentUsage[], state: Pick<AgentAccounts, 'active'> | null | undefined, agent: AgentKind): AgentUsage | undefined {
  return accountUsage(list, agent, activeAccount(state, agent))
}

const STATE_ORDER: Record<QuotaState, number> = { ok: 0, tight: 1, unknown: 2, exhausted: 3 }

// The account an agent moves to when `exclude` runs out: a signed-in one with quota, those with room
// before those near a cap or without a reading, then the least used; null when none has any.
export function pickAccount(accounts: readonly AgentAccount[], usage: readonly AgentUsage[], agent: AgentKind, exclude: AgentAccountId | null, now: number): AgentAccount | null {
  const ranked = accounts
    .filter((account) => account.agent === agent && account.signedIn && account.id !== exclude)
    .map((account, index) => {
      const verdict = quotaVerdict(accountUsage(usage, agent, account.id), now)
      return { account, index, state: verdict.state, used: verdict.window?.usedPercent ?? 0 }
    })
    .filter((entry) => entry.state !== 'exhausted')
  ranked.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.used - b.used || a.index - b.index)
  return ranked[0]?.account ?? null
}
