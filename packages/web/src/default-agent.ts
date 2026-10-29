import { isHelper, type AgentKind, type Conversation, type Task } from '@conclave/protocol'
import { currentInstalledAgents } from './installed-agents'

// New work, a task or a conversation, takes the agent picked for the latest one the user started,
// which is usually right. A part of other work (a group chat's or squad's member, a helper, a task's
// chat) or a routine's run was not picked on its own, so it does not count. An agent that is not
// installed here is never the default: the only one that is stands in, when there is exactly one,
// and otherwise the choice is left open.
export function defaultAgent(tasks: Readonly<Record<string, Task>>, conversations: Readonly<Record<string, Conversation>>): AgentKind | null {
  const started = [
    ...Object.values(tasks).flatMap((task) => task.agent ? [{ agent: task.agent, at: task.createdAt }] : []),
    ...Object.values(conversations)
      .filter((each) => !isHelper(each) && !each.taskId && !each.discussionId && !each.squadRunId && !each.parentConversationId && !each.routineId)
      .map((each) => ({ agent: each.agent, at: each.createdAt }))
  ]
  const wanted = started.sort((a, b) => b.at - a.at)[0]?.agent ?? null
  const installed = currentInstalledAgents()
  if (wanted && installed.includes(wanted)) return wanted
  return installed.length === 1 ? installed[0]! : null
}
