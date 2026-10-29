import type { AgentKind } from '@conclave/protocol'
import { Rejection } from './rejection'

// Short-lived CLI calls live in core; persistent processes are also guarded by the daemon.
export class AgentCliAccess {
  private readonly readers = new Map<AgentKind, number>()
  private readonly maintenance = new Set<AgentKind>()

  blocked(agent: AgentKind): boolean { return this.maintenance.has(agent) }

  async use<T>(agent: AgentKind, run: () => Promise<T>): Promise<T> {
    if (this.blocked(agent)) throw new Rejection('agent-cli-maintenance-running')
    this.readers.set(agent, (this.readers.get(agent) ?? 0) + 1)
    try { return await run() } finally { this.readers.set(agent, (this.readers.get(agent) ?? 1) - 1) }
  }

  reserve(agent: AgentKind): () => void {
    if (this.maintenance.size) throw new Rejection('agent-cli-maintenance-running')
    if (this.readers.get(agent)) throw new Rejection('agent-cli-active')
    this.maintenance.add(agent)
    return () => this.maintenance.delete(agent)
  }
}
export const agentCliAccess = new AgentCliAccess()
