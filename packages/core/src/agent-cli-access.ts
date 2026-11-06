import type { AgentKind } from '@conclave/protocol'
import { Rejection } from './rejection'

// Short-lived CLI calls live in core; persistent processes are also guarded by the daemon.
export class AgentCliAccess {
  private readonly readers = new Map<AgentKind, number>()
  private readonly maintenance = new Map<AgentKind, Rejection>()

  blocked(agent: AgentKind): boolean { return this.maintenance.has(agent) }

  async use<T>(agent: AgentKind, run: () => Promise<T>): Promise<T> {
    const blocked = this.maintenance.get(agent)
    if (blocked) throw blocked
    this.readers.set(agent, (this.readers.get(agent) ?? 0) + 1)
    try { return await run() } finally { this.readers.set(agent, (this.readers.get(agent) ?? 1) - 1) }
  }

  reserve(agent: AgentKind, blocked = new Rejection('agent-cli-maintenance-running')): () => void {
    if (this.maintenance.size) throw this.maintenance.get(agent) ?? new Rejection('agent-cli-maintenance-running')
    if (this.readers.get(agent)) throw new Rejection('agent-cli-active')
    this.maintenance.set(agent, blocked)
    let reserved = true
    return () => {
      if (!reserved) return
      reserved = false
      this.maintenance.delete(agent)
    }
  }
}
export const agentCliAccess = new AgentCliAccess()
