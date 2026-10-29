import { isHelper, type AgentKind, type Conversation, type Task, type TodoGroup, type TodoItem } from '@conclave/protocol'

// A list nobody has touched for this long is called out, so old ones do not bury new ones.
export const STALE_TODO_MS = 7 * 86_400_000

export type TodoLine = { groupId: string; group: string; note: string | null; item: TodoItem }

// One conversation's open to-dos in the overview: the user's first, then what its agent can take on
// when asked, each in the order of its list. Lines checked off while the overview is open stay, done,
// in their place; mine and agents count only open ones.
export type TodoEntry = {
  conversationId: string
  taskId: string | null
  title: string
  agent: AgentKind
  lines: TodoLine[]
  mine: number
  agents: number
  updatedAt: number
  // When the conversation last had a to-do added: the order, which checking one off leaves alone.
  addedAt: number
  stale: boolean
}

export type OverviewTodos = { entries: TodoEntry[]; mine: number; agents: number; archived: number }

// What is left to do across conversations and task chats. A conversation that is part of another
// (a helper, a group chat's member, a squad's member) or a routine's run is not listed on its own;
// an archived one only when asked for, and counted apart either way. `kept` names items checked off
// here, kept on show so the list holds still under the user's hand.
export function overviewTodos(
  todos: Readonly<Record<string, readonly TodoGroup[]>>,
  conversations: Readonly<Record<string, Conversation>>,
  tasks: Readonly<Record<string, Task>>,
  now: number,
  withArchived = false,
  kept: ReadonlySet<string> = new Set()
): OverviewTodos {
  const entries: TodoEntry[] = []
  let archived = 0
  for (const [conversationId, groups] of Object.entries(todos)) {
    const conversation = conversations[conversationId]
    if (!conversation || isHelper(conversation) || conversation.discussionId || conversation.squadRunId || conversation.parentConversationId || conversation.routineId) continue
    const shown = groups.flatMap((group) => group.items.filter((item) => !item.done || kept.has(item.id))
      .map((item) => ({ groupId: group.id, group: group.title, note: group.note, item })))
    const open = shown.filter((line) => !line.item.done).length
    if (shown.length === 0) continue
    if (conversation.archivedAt != null) {
      archived += open
      if (!withArchived) continue
    }
    const lines = [...shown.filter((line) => line.item.owner === 'user'), ...shown.filter((line) => line.item.owner === 'agent')]
    const task = conversation.taskId ? tasks[conversation.taskId] : undefined
    const live = groups.filter((group) => group.items.some((item) => !item.done || kept.has(item.id)))
    const updatedAt = Math.max(...live.map((group) => group.updatedAt))
    const addedAt = Math.max(...live.flatMap((group) => group.items.map((item) => item.createdAt)))
    entries.push({
      conversationId,
      taskId: task?.id ?? null,
      title: task?.title ?? conversation.title,
      agent: conversation.agent,
      lines,
      mine: lines.filter((line) => line.item.owner === 'user' && !line.item.done).length,
      agents: lines.filter((line) => line.item.owner === 'agent' && !line.item.done).length,
      updatedAt,
      addedAt,
      stale: now - updatedAt > STALE_TODO_MS
    })
  }
  // A kept line still counts for the order, so checking off the user's last one moves nothing.
  const forUser = (entry: TodoEntry) => entry.lines.some((line) => line.item.owner === 'user')
  entries.sort((a, b) => Number(forUser(b)) - Number(forUser(a)) || b.addedAt - a.addedAt)
  return {
    entries,
    mine: entries.reduce((sum, entry) => sum + entry.mine, 0),
    agents: entries.reduce((sum, entry) => sum + entry.agents, 0),
    archived
  }
}
