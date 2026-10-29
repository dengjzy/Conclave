import type { AgentKind } from './agent'
import { agentDescriptor } from './agents'
import type { Environment } from './environment'
import { providerEndpoint, type ModelProvider, type ModelProviderProbe } from './model-provider'

export type ProviderReadiness = Readonly<Record<string, { revision: number; result: ModelProviderProbe | 'running' }>>

export type AgentReadiness =
  | { state: 'checking' | 'unsupported' | 'disabled' | 'missing' | 'cli-missing' | 'incompatible-version' | 'probe-failed' | 'needs-check' | 'needs-account' | 'needs-provider' | 'unknown-auth' | 'authorize-on-use' }
  | { state: 'ready'; via: 'account' }
  | { state: 'ready'; via: 'provider'; provider: ModelProvider }
  | { state: 'provider-failed'; provider: ModelProvider; message: string | null }

export function agentReadiness(agent: AgentKind, environment: Pick<Environment, 'checks' | 'detectedAgents'> | null, disabled: readonly AgentKind[], providers: readonly ModelProvider[], probes: ProviderReadiness = {}): AgentReadiness {
  if (!environment) return { state: 'checking' }
  const check = environment.checks.find((entry) => entry.tool === agent)
  if (!check) return { state: 'unsupported' }
  if (disabled.includes(agent)) return { state: 'disabled' }
  if (check.status === 'missing') {
    const app = environment.detectedAgents?.find((entry) => entry.id === agent)?.locations.some((location) => location.source === 'application')
    return { state: app && !agentDescriptor(agent).environment.missing ? 'cli-missing' : 'missing' }
  }
  if (check.problem) return { state: check.problem }
  if (check.status === 'unknown') return { state: 'needs-check' }
  if (check.signedIn === true) return { state: 'ready', via: 'account' }
  const compatible = providers.filter((entry) => entry.hasKey && providerEndpoint(entry, agent) !== null)
  const failure = (entry: ModelProvider): ModelProviderProbe | null => {
    const probe = probes[entry.id]
    return probe?.revision === entry.revision && probe.result !== 'running' && !probe.result.ok ? probe.result : null
  }
  const provider = compatible.find((entry) => !failure(entry))
  if (provider) return { state: 'ready', via: 'provider', provider }
  const failed = compatible[0]
  if (failed) return { state: 'provider-failed', provider: failed, message: failure(failed)?.checks.find((entry) => !entry.ok)?.message ?? null }
  const setup = agentDescriptor(agent).setup
  if (setup === 'first-use') return { state: 'authorize-on-use' }
  if (check.signedIn === null) return { state: 'unknown-auth' }
  return { state: setup === 'provider' ? 'needs-provider' : 'needs-account' }
}

// A user's confirmation belongs to this installation, never a replacement or a failed probe.
export function agentSetupIdentity(agent: AgentKind, environment: Environment | null): string | null {
  const check = environment?.checks.find((entry) => entry.tool === agent)
  return check?.status === 'ok' && !check.problem ? JSON.stringify([agent, check.path, check.version]) : null
}
