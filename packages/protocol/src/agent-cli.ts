import { z } from 'zod'
import { AgentKind } from './agent'
import { Terminal } from './terminal'

export const AgentCliStatus = z.object({
  agent: AgentKind,
  revision: z.number().int().nonnegative().default(0),
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  path: z.string().nullable(),
  channel: z.enum(['npm', 'pnpm', 'bun', 'homebrew', 'native', 'desktop', 'unknown']),
  availability: z.enum(['current', 'available', 'managed', 'unknown', 'missing']),
  canUpgrade: z.boolean(),
  phase: z.enum(['idle', 'checking', 'starting', 'running', 'succeeded', 'unchanged', 'error', 'cancelled']),
  error: z.string().nullable(),
  checkedAt: z.number().nullable(),
  terminalId: z.string().nullable(),
  blockers: z.array(z.string()),
  upgradeCommand: z.string().nullable().optional()
})
export type AgentCliStatus = z.infer<typeof AgentCliStatus>
export const AgentCliUpgrade = z.object({ status: AgentCliStatus, terminal: Terminal.nullable() })
export type AgentCliUpgrade = z.infer<typeof AgentCliUpgrade>

export function initialAgentCliStatus(agent: z.infer<typeof AgentKind>): AgentCliStatus {
  return { agent, revision: 0, currentVersion: null, latestVersion: null, path: null, channel: 'unknown', availability: 'unknown', canUpgrade: false, phase: 'idle', error: null, checkedAt: null, terminalId: null, blockers: [], upgradeCommand: null }
}
