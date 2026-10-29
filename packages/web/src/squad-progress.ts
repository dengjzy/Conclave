import { t } from './i18n'
import { squadWorkActive, squadWorkOpen, type Conversation, type ConversationDoing, type SquadMember, type SquadRun, type SquadWork } from '@conclave/protocol'
import { toolLabel } from './chat-tools'

// How a squad's run reads at a glance: who works now and at what, and its work in the order the
// user looks for it.

export type MemberState = 'awaiting' | 'running' | 'starting' | 'queued' | 'idle'

export type MemberProgress = {
  member: SquadMember
  leader: boolean
  state: MemberState
  // The line under the name: what the member is doing, asked, or waiting for; null for nothing to say.
  detail: string | null
  // Where its work goes on, to open; null before it has one.
  conversationId: string | null
  // When the work it is on started, for a running clock.
  since: number | null
}

export function doingText(doing: ConversationDoing | null | undefined): string | null {
  if (!doing) return null
  return doing.tool ? `${toolLabel(doing.tool)} ${doing.title}`.trim() : doing.title
}

// A work's instruction as one line: its first that says anything, without Markdown's marks.
export function workHeadline(text: string): string {
  const line = text.split('\n').find((each) => each.trim()) ?? ''
  return line.replace(/^\s*(?:#+|[-*>]|\d+\.)\s+/, '').replace(/`+/g, '').replace(/(\*\*|__)(.+?)\1/g, '$2').trim()
}

// A turn the conversation says waits on the user outranks the work's own state: the member asked
// after the work began.
function fromConversation(conversation: Conversation | undefined): { state: MemberState; detail: string | null } | null {
  const turn = conversation?.chat?.turn
  if (turn === 'awaiting') return { state: 'awaiting', detail: conversation?.chat?.request?.title || null }
  if (turn === 'running') return { state: 'running', detail: doingText(conversation?.chat?.doing) }
  return null
}

export function memberProgress(run: SquadRun, conversations: Readonly<Record<string, Conversation>>): MemberProgress[] {
  const live = run.state === 'running' || run.state === 'paused'
  return run.squad.members.map((member): MemberProgress => {
    const leader = member.id === run.squad.leaderId
    if (leader) {
      const conversationId = run.leaderConversationId
      const seen = live ? fromConversation(conversationId ? conversations[conversationId] : undefined) : null
      const waitingOnMembers = run.works.some(squadWorkOpen)
      return { member, leader, state: seen?.state ?? 'idle', detail: seen?.detail ?? (live && waitingOnMembers ? t('squadProgress.waitingForMemberDelivery') : null), conversationId, since: null }
    }
    const works = run.works.filter((work) => work.memberId === member.id)
    const active = works.findLast(squadWorkActive)
    const queued = works.filter((work) => work.state === 'queued')
    const latest = works.at(-1)
    const conversationId = active?.conversationId ?? latest?.conversationId ?? null
    if (active) {
      const seen = fromConversation(active.conversationId ? conversations[active.conversationId] : undefined)
      const state: MemberState = seen?.state ?? (active.state === 'awaiting' ? 'awaiting' : active.state === 'starting' ? 'starting' : 'running')
      return { member, leader, state, detail: seen?.detail ?? workHeadline(active.instruction), conversationId, since: active.updatedAt }
    }
    const [next] = queued
    if (live && next) return { member, leader, state: 'queued', detail: queued.length > 1 ? t('squadProgress.assignmentsQueued', { value1: queued.length }) : workHeadline(next.instruction), conversationId, since: null }
    return { member, leader, state: 'idle', detail: null, conversationId, since: null }
  })
}

// What goes on first, in the order it was handed out; then what ended, the latest first.
export function orderedWorks(works: readonly SquadWork[]): { open: SquadWork[]; ended: SquadWork[] } {
  const open = works.filter(squadWorkOpen)
  const ended = works.filter((work) => !squadWorkOpen(work)).sort((a, b) => b.updatedAt - a.updatedAt)
  return { open, ended }
}

// A running clock: m:ss, then h:mm:ss.
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

