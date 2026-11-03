import { agentDescriptor, type AgentKind, type AgentProfileFields, type ChatCatalog, type Conversation, type Environment } from '@conclave/protocol'
import type { ModelChoice } from './agent-models'
import { discussionModelChoice, discussionModelReady } from './discussion-model'

export function directDelegationAllowed(conversation: Conversation, features: readonly string[]): boolean {
  return features.includes('direct-agent-calls') && !conversation.profile
}

export function delegationReadOnly(conversation: Conversation): boolean {
  return Boolean(conversation.workspaceReadOnly || conversation.planOnly || ['plan', 'readOnly'].includes(conversation.chatOptions?.permissionMode ?? ''))
}

// Unlike a discovery picker, dispatch must offer only executables the current core actually found.
export function delegationAgents(environment: Environment | null, installed: readonly AgentKind[]): readonly AgentKind[] {
  return installed.filter((agent) => environment?.checks.some((check) => check.tool === agent && check.status !== 'missing' && check.problem !== 'incompatible-version'))
}

export function delegationAgent(agents: readonly AgentKind[], selected: AgentKind | null): AgentKind | null {
  if (selected) return agents.includes(selected) ? selected : null
  return agents.find((agent) => agentDescriptor(agent).capabilities.readOnly !== false) ?? agents[0] ?? null
}

export function directDelegationTarget(conversation: Conversation, agent: AgentKind | null, capability: 'readOnly' | 'develop', catalog: ChatCatalog | null | undefined, choice: ModelChoice, modelProvider: string | null) {
  const effectiveCapability = delegationReadOnly(conversation) ? 'readOnly' : capability
  if (!agent || (effectiveCapability === 'readOnly' && agentDescriptor(agent).capabilities.readOnly === false) || !discussionModelReady(catalog, choice)) return null
  return { agent, ...discussionModelChoice(catalog, choice), modelProvider, capability: effectiveCapability }
}

export function delegationInstruction(goal: string, context: string): string {
  return [goal.trim(), context.trim()].filter(Boolean).join('\n\n')
}

export function delegationRoleFields(target: NonNullable<ReturnType<typeof directDelegationTarget>>, name: string): AgentProfileFields {
  return { ...target, name: name.trim() }
}
