import { AGENT_KINDS, isHelper, type AgentKind, type Conversation, type Discussion } from '@conclave/protocol'
import { getLocale, t } from './i18n'
import { agentLabel } from './labels'
import type { Preferences } from './preferences'
import { primaryProjectName, projectName } from './components/ProjectPicker'

export type ConversationHistoryFilter = 'all' | 'single' | 'group'
export type ConversationHistoryEntry = { kind: 'single'; value: Conversation } | { kind: 'group'; value: Discussion }
type GroupBy = Preferences['conversationGroup']
type SortBy = Preferences['conversationSort']
export type ConversationHistoryGroup = {
  key: string; label: string | null; rank: number; items: ConversationHistoryEntry[]; project?: string; agent?: AgentKind
}

export const historyKey = (entry: ConversationHistoryEntry): string => `${entry.kind}:${entry.value.id}`

// A group's member conversations remain inside its history entry, not duplicated in the list.
export function conversationHistory(conversations: Record<string, Conversation>, discussions: Record<string, Discussion>, filter: ConversationHistoryFilter = 'all'): ConversationHistoryEntry[] {
  const singles: ConversationHistoryEntry[] = filter === 'group' ? [] : Object.values(conversations)
    .filter((conversation) => !isHelper(conversation) && !conversation.taskId && !conversation.routineId && !conversation.discussionId && !conversation.squadRunId && !conversation.parentConversationId && conversation.deletion?.state !== 'running')
    .map((value) => ({ kind: 'single', value }))
  return filter === 'single' ? singles : [...singles, ...Object.values(discussions).map((value): ConversationHistoryEntry => ({ kind: 'group', value }))]
}

export function historyMatches(entry: ConversationHistoryEntry, query: string): boolean {
  const needle = query.toLocaleLowerCase()
  const common = [entry.value.title, ...entry.value.projectPaths.map(projectName)]
  const fields = entry.kind === 'group'
    ? [...common, entry.value.topic, ...entry.value.members.flatMap((member) => [member.name, agentLabel(member.agent), member.model ?? ''])]
    : common
  return fields.some((text) => text.toLocaleLowerCase().includes(needle))
}

export function historyGroupOf(entry: ConversationHistoryEntry, by: Exclude<GroupBy, 'none'>): { label: string; rank: number } {
  if (by === 'project') return { label: primaryProjectName(entry.value.projectPaths), rank: entry.value.projectPaths.length > 0 ? 0 : 1 }
  if (by === 'agent') return entry.kind === 'single'
    ? { label: agentLabel(entry.value.agent), rank: AGENT_KINDS.indexOf(entry.value.agent) }
    : { label: t('ConversationHistory.groupByAgent'), rank: AGENT_KINDS.length }
  const running = entry.kind === 'single' ? Boolean(entry.value.sessionId)
    : entry.value.state === 'running' || entry.value.state === 'pausing' || entry.value.members.some((member) => member.status !== 'idle')
  return running ? { label: t('ConversationList.running'), rank: 0 } : { label: t('ConversationList.stopped'), rank: 1 }
}

export function sortHistory(entries: ConversationHistoryEntry[], sort: SortBy): ConversationHistoryEntry[] {
  return [...entries].sort((a, b) => {
    const order = sort === 'recent' ? b.value.updatedAt - a.value.updatedAt
      : sort === 'created' ? b.value.createdAt - a.value.createdAt
        : a.value.title.localeCompare(b.value.title, getLocale())
    return order || historyKey(a).localeCompare(historyKey(b))
  })
}

export function arrangeHistory(entries: ConversationHistoryEntry[], by: GroupBy, sort: SortBy): ConversationHistoryGroup[] {
  const sorted = sortHistory(entries, sort)
  const pinned = sorted.filter((entry) => entry.value.pinnedAt != null)
  const rest = sorted.filter((entry) => entry.value.pinnedAt == null)
  const top: ConversationHistoryGroup[] = pinned.length ? [{ key: 'pinned', label: t('ConversationList.pinned'), rank: -1, items: pinned }] : []
  if (by === 'none') return rest.length ? [...top, { key: 'all', label: null, rank: 0, items: rest }] : top
  const groups = new Map<string, ConversationHistoryGroup>()
  for (const entry of rest) {
    const { label, rank } = historyGroupOf(entry, by)
    const project = by === 'project' ? entry.value.projectPaths[0] : undefined
    const agent = by === 'agent' && entry.kind === 'single' ? entry.value.agent : undefined
    const group = groups.get(label) ?? { key: `group:${label}`, label, rank, items: [], ...(project ? { project } : {}), ...(agent ? { agent } : {}) }
    group.items.push(entry)
    groups.set(label, group)
  }
  return [...top, ...[...groups.values()].sort((a, b) => a.rank - b.rank || (a.label ?? '').localeCompare(b.label ?? '', getLocale()))]
}

export function shownHistoryRows(items: ConversationHistoryEntry[], selected: string | null, limit: number): ConversationHistoryEntry[] {
  return items.filter((entry, index) => index < limit || historyKey(entry) === selected)
}
