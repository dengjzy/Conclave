import { getLocale } from './i18n'
import { useMemo } from 'react'
import type { AgentKind, Conversation, ConversationDoing, Task } from '@conclave/protocol'
import { toolLabel } from './chat-tools'
import { useCore } from './core-store'
import { agentLabel } from './labels'

// Who is at work on something right now, said one way on the board, in a task's header and in
// the inspector: waiting on the user outranks working, as it is what the user can act on.
export type WorkActivity = {
  state: 'running' | 'awaiting'
  workers: { agent: AgentKind; name: string }[]
  // What the first of them is doing, or asked.
  detail: string | null
}

export function doingText(doing: ConversationDoing | null | undefined): string | null {
  if (!doing) return null
  return doing.tool ? `${toolLabel(doing.tool)} ${doing.title}`.trim() : doing.title
}

export function conversationActivity(conversation: Conversation | undefined, agent: AgentKind, name = agentLabel(agent)): WorkActivity | null {
  if (!conversation?.sessionId) return null
  const turn = conversation.chat?.turn
  if (turn === 'awaiting') return { state: 'awaiting', workers: [{ agent, name }], detail: conversation.chat?.request?.title || null }
  if (turn === 'running' || conversation.starting) return { state: 'running', workers: [{ agent, name }], detail: doingText(conversation.chat?.doing) }
  return null
}

export function taskActivity(task: Task, conversations: Readonly<Record<string, Conversation>>): WorkActivity | null {
  return task.agent ? conversationActivity(task.conversationId ? conversations[task.conversationId] : undefined, task.agent) : null
}

export function useTaskActivity(task: Task | undefined): WorkActivity | null {
  const conversations = useCore((state) => state.conversations)
  return useMemo(() => (task ? taskActivity(task, conversations) : null), [task, conversations, getLocale()])
}
