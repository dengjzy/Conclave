import { AGENT_KINDS, type AgentCliInstallation, type AgentKind, type Environment, type Terminal } from '@conclave/protocol'
import { adapterOf } from './agents'
import type { EnvironmentService } from './environment-check'
import type { TerminalService } from './terminal-service'
import { Rejection } from './rejection'

// Offered for an agent whose application is there without its CLI, by the commands its maker
// publishes for the core host rather than the client OS; or, for one whose runtime Conclave
// downloads itself, whenever that is missing.
export function agentCliInstallations(environment: Pick<Environment, 'checks' | 'detectedAgents'>, platform: NodeJS.Platform): AgentCliInstallation[] {
  return AGENT_KINDS.flatMap((kind) => {
    const adapter = adapterOf(kind)
    const installation = adapter.installation?.(platform)
    if (!installation) return []
    const check = environment.checks.find((each) => each.tool === kind)
    const locations = environment.detectedAgents?.find((each) => each.id === kind)?.locations ?? []
    return check?.status === 'missing' && check.path === null &&
      (adapter.installWithoutApplication || locations.some((each) => each.source === 'application')) && !locations.some((each) => each.source === 'cli')
      ? [installation] : []
  })
}

export class AgentCliInstaller {
  private readonly pending = new Map<AgentKind, Promise<Terminal>>()

  constructor(private readonly environment: Pick<EnvironmentService, 'check'>, private readonly terminals: Pick<TerminalService, 'list' | 'installCli'>) {}

  install(agent: AgentKind): Promise<Terminal> {
    const pending = this.pending.get(agent)
    if (pending) return pending
    const installing = this.start(agent).finally(() => this.pending.delete(agent))
    this.pending.set(agent, installing)
    return installing
  }

  private async start(agent: AgentKind): Promise<Terminal> {
    const environment = await this.environment.check(true)
    const installation = environment.cliInstallations?.find((each) => each.agent === agent)
    if (!installation) throw new Rejection('agent-cli-install-unavailable', '仅在检测到 App 且未找到 CLI 时可以安装，请重新检测')
    // The row survives core restarts, so another window or a reconnect uses the running tab.
    const running = this.terminals.list().find((each) => !each.conversationId && each.command === installation.command && !each.exited)
    if (running) return running
    const terminal = await this.terminals.installCli(installation)
    if (terminal.exited) await this.environment.check(true)
    return terminal
  }
}
