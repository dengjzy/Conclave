import type { AgentCliStatus, AgentKind } from '@conclave/protocol'

type CliStatuses = Partial<Record<AgentKind, AgentCliStatus>>

// Checking all agents may finish after an upgrade's newer notifications already arrived.
export function mergeCliStatuses(current: CliStatuses, incoming: readonly AgentCliStatus[]): CliStatuses {
  const next = { ...current }
  for (const status of incoming) {
    if (status.revision >= (next[status.agent]?.revision ?? -1)) next[status.agent] = status
  }
  return next
}
