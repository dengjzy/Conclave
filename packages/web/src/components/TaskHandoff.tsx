import { useCallback } from 'react'
import { checkTaskHandoff, type AgentKind, type Task } from '@conclave/protocol'
import { useCore, useTaskHandoffSupported } from '../core-store'
import { reasonText } from '../labels'
import { beginHandoff } from './ConversationActions'

export type TaskHandoff = {
  // A core that hands tasks off, and a chat to hand.
  available: boolean
  // Why it cannot go now, or null.
  blocker: string | null
  // Readies the handoff in the task's chat, to the agent already picked if there is one.
  open: (agent?: AgentKind) => void
}

// Handing a task's chat to another agent, from wherever the task offers it: each way leads to the
// chat's composer, which sends it.
export function useTaskHandoff(task: Task | undefined): TaskHandoff {
  const supported = useTaskHandoffSupported()
  const conversation = useCore((s) => (task?.conversationId ? s.conversations[task.conversationId] : undefined))
  const tasks = useCore((s) => s.tasks)
  const open = useCallback((agent?: AgentKind) => {
    if (conversation) beginHandoff(conversation, agent)
  }, [conversation])
  if (!task || task.squadId || !conversation) return { available: false, blocker: null, open }
  const dependencies = task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined)
  const found = checkTaskHandoff(task, dependencies, conversation.sessionId ? (conversation.chat?.turn ?? null) : null)
  return { available: supported, blocker: found && reasonText(found, found), open }
}
