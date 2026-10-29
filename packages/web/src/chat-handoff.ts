import { create } from 'zustand'
import type { AgentKind, ChatPermissionMode } from '@conclave/protocol'

// A conversation's handoff while the user sets it up in its composer: the agent picked to take the
// work over, and the mode, model and effort it starts in. Nothing happens until the composer sends it.
export type PendingHandoff = { agent: AgentKind; permissionMode?: ChatPermissionMode; model?: string; effort?: string }

export const useHandoffs = create<Record<string, PendingHandoff>>()(() => ({}))

export function proposeHandoff(conversationId: string, agent: AgentKind): void {
  useHandoffs.setState({ [conversationId]: { agent } })
}

export function chooseHandoffModel(conversationId: string, choice: { model?: string; effort?: string }): void {
  useHandoffs.setState((state) => {
    const pending = state[conversationId]
    return pending ? { [conversationId]: { agent: pending.agent, ...(pending.permissionMode ? { permissionMode: pending.permissionMode } : {}), ...choice } } : {}
  })
}

export function chooseHandoffMode(conversationId: string, permissionMode: ChatPermissionMode): void {
  useHandoffs.setState((state) => {
    const pending = state[conversationId]
    return pending ? { [conversationId]: { ...pending, permissionMode } } : {}
  })
}

export function cancelHandoff(conversationId: string): void {
  useHandoffs.setState((state) => {
    const { [conversationId]: _cancelled, ...rest } = state
    return rest
  }, true)
}
