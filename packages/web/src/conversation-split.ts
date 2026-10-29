import { isHelper, type Conversation } from '@conclave/protocol'

// Two conversations side by side, left then right. The one in front is the selected conversation;
// these rules say what selecting, opening beside and closing do to the pair, kept apart from the
// store so they can be read and tested on their own.
export type SplitPanes = readonly [string, string]

export function splitPanesOf(saved: readonly string[]): SplitPanes | null {
  const [left, right] = saved
  return left && right && left !== right ? [left, right] : null
}

// Showing only while the conversation in front is one of the two.
export function shownPanes(panes: SplitPanes | null, current: string | null): SplitPanes | null {
  return panes && current && panes.includes(current) ? panes : null
}

// Selecting a conversation: one of the two is brought to the front; another takes the place of the
// one that was in front, as an editor's tab does; from anywhere else the pair is put away.
export function panesAfterSelect(panes: SplitPanes | null, current: string | null, id: string | null): SplitPanes | null {
  if (!panes || id === null || panes.includes(id)) return panes
  if (!current || !panes.includes(current)) return null
  return panes[0] === current ? [id, panes[1]] : [panes[0], id]
}

// Opening a conversation beside the one in front: on its right when there is only one, in place of
// the other when two are showing. Nothing in front, or the same one, opens nothing.
export function panesBeside(panes: SplitPanes | null, current: string | null, id: string): SplitPanes | null {
  if (!current || current === id) return shownPanes(panes, current)
  const shown = shownPanes(panes, current)
  if (!shown) return [current, id]
  if (shown.includes(id)) return shown
  return shown[0] === current ? [current, id] : [id, current]
}

// Closing a column leaves the other on its own.
export function closePane(panes: SplitPanes, id: string): string {
  return panes[0] === id ? panes[1] : panes[0]
}

// What can stand beside another: a conversation of the list, not a task's chat, a helper, a group
// member, a squad member or a routine's run, and not put away.
export function canSplit(conversation: Conversation): boolean {
  return !isHelper(conversation) && !conversation.taskId && !conversation.discussionId && !conversation.squadRunId && !conversation.routineId && conversation.archivedAt == null
}

// ⌘\ from one conversation: the pair put away last, as it was, where this is one of it and the
// other is still there to show; else this one on the left, beside the other of that pair or the
// conversation the user was in most recently.
export function restorePanes(current: string, last: readonly string[], conversations: Readonly<Record<string, Conversation>>): SplitPanes | null {
  const showable = (id: string | undefined) => {
    const each = id === undefined || id === current ? undefined : conversations[id]
    return each !== undefined && canSplit(each)
  }
  const pair = splitPanesOf(last)
  if (pair?.includes(current)) {
    const other = closePane(pair, current)
    if (showable(other)) return pair
  }
  const partner = last.find(showable) ?? Object.values(conversations)
    .filter((each) => showable(each.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
  return partner ? [current, partner] : null
}
