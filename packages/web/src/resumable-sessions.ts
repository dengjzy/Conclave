import { agentReadiness, type AgentKind, type Environment, type ExternalSession, type ModelProvider, type ProviderReadiness } from '@conclave/protocol'

export const RESUMABLE_SHOWN = 3

// An agent that can take a session up again: installed, on, and not known to be signed out.
export function canResume(agent: AgentKind, environment: Environment | null, disabled: readonly AgentKind[], providers: readonly ModelProvider[], probes?: ProviderReadiness): boolean {
  const { state } = agentReadiness(agent, environment, disabled, providers, probes)
  return state === 'ready' || state === 'unknown-auth' || state === 'authorize-on-use'
}

// All the sessions there are to go on with, and the newest few to offer, one per folder: a dozen
// sessions in one project must not crowd out the others.
export function resumableSessions(sessions: readonly ExternalSession[], usable: (agent: AgentKind) => boolean): { count: number; agents: AgentKind[]; shown: ExternalSession[] } {
  const candidates = sessions.filter((session) => session.status === 'new' && session.problem === null && usable(session.agent))
  const folders = new Set<string>()
  const shown = [...candidates].sort((a, b) => b.updatedAt - a.updatedAt).filter((session) => {
    if (folders.has(session.cwd)) return false
    folders.add(session.cwd)
    return true
  })
  return { count: candidates.length, agents: [...new Set(candidates.map((session) => session.agent))], shown: shown.slice(0, RESUMABLE_SHOWN) }
}
