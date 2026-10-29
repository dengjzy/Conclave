import { providerEndpoint, type AgentKind, type ModelProvider } from '@conclave/protocol'

// The providers an agent can start on: ones with a key that serve it.
export function servingProviders(providers: readonly ModelProvider[], agent: AgentKind): ModelProvider[] {
  return providers.filter((provider) => provider.hasKey && providerEndpoint(provider, agent) !== null)
}

// The provider picked, where it serves this agent; another agent runs on its own account.
export function providerFor(providers: readonly ModelProvider[], id: string | null | undefined, agent: AgentKind | null): ModelProvider | null {
  if (!id || !agent) return null
  return servingProviders(providers, agent).find((provider) => provider.id === id) ?? null
}

// What an agent's models are kept under: a provider offers its own, which an edit may change.
export function catalogKey(agent: AgentKind, provider: ModelProvider | null): string {
  return provider ? `${agent}|${provider.id}|${provider.revision}` : agent
}
