import { z } from 'zod'
import { conclaveToolName } from './chat'

// What is left to do after a turn, kept per conversation by Conclave rather than in an agent's session,
// so it outlives the turn, a restart and a handoff: what the agent writes down for the user (or for
// whichever agent goes on), and what the user adds. Grouped as a reply lists them: a heading, the
// items under it. Not the agent's own step list for the turn (ChatTodo), which it replaces at will.
export const TODO_OWNERS = ['user', 'agent'] as const
export const TodoOwner = z.enum(TODO_OWNERS)
export type TodoOwner = z.infer<typeof TodoOwner>

export const MAX_TODO_GROUPS = 50
export const MAX_TODO_ITEMS = 30

export const TodoTitle = z.string().trim().min(1).max(120)
export const TodoText = z.string().trim().min(1).max(500)

export const TodoItem = z.object({
  id: z.string(),
  text: TodoText,
  // Who it falls to: the user, or an agent, which may do it when asked.
  owner: TodoOwner,
  done: z.boolean(),
  createdAt: z.number(),
  doneAt: z.number().nullable()
})
export type TodoItem = z.infer<typeof TodoItem>

export const TodoGroup = z.object({
  id: z.string(),
  title: TodoTitle,
  // When or why, in a few words: 上线前, 可选.
  note: z.string().trim().max(120).nullable(),
  items: z.array(TodoItem).max(MAX_TODO_ITEMS),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type TodoGroup = z.infer<typeof TodoGroup>

export const TodoList = z.array(TodoGroup).max(MAX_TODO_GROUPS)

export function todoGroupDone(group: Pick<TodoGroup, 'items'>): boolean {
  return group.items.length > 0 && group.items.every((item) => item.done)
}

export function openTodoCount(groups: readonly Pick<TodoGroup, 'items'>[]): number {
  return groups.reduce((sum, group) => sum + group.items.filter((item) => !item.done).length, 0)
}

// The agent's tools for them, through Conclave's MCP server. Named for the user: an agent that sees
// only the names (Claude Code defers MCP tools) would take a bare todo for its own plan.
export const TODO_TOOLS = ['list', 'add', 'check'] as const
export type TodoToolKind = (typeof TODO_TOOLS)[number]
export function todoToolName(kind: TodoToolKind): string {
  return `user_todo_${kind}`
}
export function todoToolKind(name: string): TodoToolKind | null {
  const own = conclaveToolName(name)
  return TODO_TOOLS.find((kind) => own === todoToolName(kind)) ?? null
}
