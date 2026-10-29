import { z } from 'zod'
import { AgentKind, agentReadiness, agentSetupIdentity, AGENT_KINDS, type Environment, type ExternalSession, type ModelProvider, type ProviderReadiness, type SourceDescriptor } from '@conclave/protocol'
import { canResume, resumableSessions } from './resumable-sessions'

export const SetupProgress = z.object({
  status: z.enum(['new', 'active', 'paused', 'complete', 'dismissed']).catch('new'),
  agent: AgentKind.nullable().catch(null),
  confirmed: z.string().nullable().catch(null),
  sourceChoice: z.enum(['pending', 'configure', 'skip']).catch('pending'),
  sessionChoice: z.enum(['pending', 'resumed', 'skip']).catch('pending')
}).catch({ status: 'new', agent: null, confirmed: null, sourceChoice: 'pending', sessionChoice: 'pending' })
export type SetupProgress = z.infer<typeof SetupProgress>

export type SetupSituation = {
  environment: Environment | null
  disabled: readonly AgentKind[]
  providers: readonly ModelProvider[]
  sources: readonly SourceDescriptor[] | null
  probes?: ProviderReadiness
  // Sessions the agents ran outside Conclave; null while they are being looked for.
  sessions: readonly ExternalSession[] | null
}

export function initialSetupStatus(guideSeen: boolean, hasWork: boolean): SetupProgress['status'] {
  return guideSeen || hasWork ? 'dismissed' : 'active'
}

export function preferredSetupAgent({ environment, disabled, providers, probes }: SetupSituation): AgentKind | null {
  const known = AGENT_KINDS.filter((agent) => environment?.checks.some((entry) => entry.tool === agent))
  return known.find((agent) => agentReadiness(agent, environment, disabled, providers, probes).state === 'ready')
    ?? known.find((agent) => !disabled.includes(agent) && environment?.checks.some((entry) => entry.tool === agent && entry.status !== 'missing'))
    ?? known[0] ?? null
}

export function configuredSources(sources: readonly SourceDescriptor[]): SourceDescriptor[] {
  return sources.filter((source) => source.instances.some((instance) => instance.credential.configured
    && source.settings.every((field) => !field.required || Boolean(instance.settings[field.key]?.trim()))))
}

export function setupResumable(situation: SetupSituation): ReturnType<typeof resumableSessions> {
  const { environment, disabled, providers, probes } = situation
  return resumableSessions(situation.sessions ?? [], (agent) => canResume(agent, environment, disabled, providers, probes))
}

// Going on with work already under way comes before anything new: right after an agent can run it.
export function setupStep(progress: SetupProgress, situation: SetupSituation): 'waiting' | 'agent' | 'sessions' | 'sources' | 'done' {
  if (!situation.environment || situation.sources === null) return 'waiting'
  const agent = progress.agent ?? preferredSetupAgent(situation)
  if (!agent) return 'agent'
  const readiness = agentReadiness(agent, situation.environment, situation.disabled, situation.providers, situation.probes)
  const confirmed = (readiness.state === 'unknown-auth' || readiness.state === 'authorize-on-use')
    && progress.confirmed !== null && progress.confirmed === agentSetupIdentity(agent, situation.environment)
  if (readiness.state !== 'ready' && !confirmed) return 'agent'
  if (progress.sessionChoice === 'pending' && (situation.sessions === null || setupResumable(situation).count > 0)) return 'sessions'
  return progress.sourceChoice === 'skip' || configuredSources(situation.sources).length > 0 ? 'done' : 'sources'
}
