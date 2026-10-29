import { z } from 'zod'
import { AgentKind } from './agent'
import { MAX_TASK_REPOS } from './task'

// A group chat: several agents, each in a conversation of its own that the list does not show,
// discuss a topic in rounds. The first round they answer alone; in each after it every member reads
// what the others said since and answers it; then the chair sums up. They read and never change.

export const MIN_DISCUSSION_MEMBERS = 2
export const MAX_DISCUSSION_MEMBERS = 5
export const MAX_DISCUSSION_ROUNDS = 5
export const DEFAULT_DISCUSSION_ROUNDS = 3
export const MAX_DISCUSSION_REQUIREMENTS = 10000
export const DEFAULT_DISCUSSION_REQUIREMENTS = [
  '- 观点要具体，给出理由；不确定的地方直接说不确定。',
  '- 每次发言尽量控制在 600 字以内，除非主题确实需要更多。'
].join('\n')

export const DiscussionMemberFields = z.object({
  agent: AgentKind,
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(60),
  // The stance or angle it is to take, in the user's words; empty for none.
  role: z.string().trim().max(2000).default('')
})
export type DiscussionMemberFields = z.input<typeof DiscussionMemberFields>

// working: a turn of the discussion's is running; awaiting: it waits on the user (an approval, a question).
export const DiscussionMemberStatus = z.enum(['idle', 'working', 'awaiting'])
export type DiscussionMemberStatus = z.infer<typeof DiscussionMemberStatus>

export const DiscussionMember = DiscussionMemberFields.extend({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  role: z.string(),
  status: DiscussionMemberStatus.catch('idle'),
  // Its place in the order members joined, never given again, so its letter (A, B…) stays when one
  // before it leaves. Older cores leave it out: the place in the list stands in.
  position: z.number().int().nonnegative().optional()
})
export type DiscussionMember = z.infer<typeof DiscussionMember>

// The letter a member goes by in the group: its face, and its code when the discussion is anonymous.
export function memberLetter(discussion: Pick<Discussion, 'members' | 'formerMembers'>, memberId: string): string | null {
  const index = discussion.members.findIndex((member) => member.id === memberId)
  const member = discussion.members[index] ?? discussion.formerMembers.find((each) => each.id === memberId)
  if (!member) return null
  return String.fromCharCode(65 + (member.position ?? index))
}

// running: turns are out, or the next step is about to go; pausing: the user paused, and the turns
// still out are let finish; paused: nothing out, more to come when resumed; done: summed up.
export const DiscussionState = z.enum(['running', 'pausing', 'paused', 'done'])
export type DiscussionState = z.infer<typeof DiscussionState>

export const Discussion = z.object({
  id: z.string().uuid(),
  title: z.string(),
  topic: z.string(),
  // Shared instructions for every turn; omitted by older cores, empty for no extra requirements.
  requirements: z.string().optional(),
  projectPaths: z.array(z.string()),
  members: z.array(DiscussionMember),
  // Members taken out, for the names on what they said. Older cores leave it out.
  formerMembers: z.array(DiscussionMember).default([]),
  chairId: z.string().uuid(),
  maxRounds: z.number().int().min(1).max(MAX_DISCUSSION_ROUNDS),
  // Whether members see each other as 成员 A, B… rather than by name, model and agent.
  anonymous: z.boolean(),
  state: DiscussionState.catch('paused'),
  // What the turns last sent out were: a round of the discussion, or the summary.
  step: z.enum(['round', 'summary']).nullable(),
  // The round last sent out, 0 before the first; lastRound is the one the summary follows.
  round: z.number().int().nonnegative(),
  lastRound: z.number().int().nonnegative(),
  // The round before the one the topic now discussed opened: the user may move the group on to a new
  // one, whose rounds count from here. Older cores leave it out.
  topicStart: z.number().int().nonnegative().default(0),
  pinnedAt: z.number().nullable(),
  // When the user put it away: out of the list and read-only until taken out again. Older cores
  // leave it out.
  archivedAt: z.number().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Discussion = z.infer<typeof Discussion>

// opening: a member's first, independent answer; rebuttal: its answer in a later round; reply: to
// the user who named it; notice: Conclave's own line, as when a member's turn failed.
export const DiscussionPostKind = z.enum(['opening', 'rebuttal', 'reply', 'summary', 'user', 'notice'])
export type DiscussionPostKind = z.infer<typeof DiscussionPostKind>

export const DiscussionPost = z.object({
  id: z.string().uuid(),
  discussionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  // The member who said it; null for the user and for notices.
  memberId: z.string().uuid().nullable(),
  kind: DiscussionPostKind.catch('notice'),
  text: z.string(),
  // The members a user's post names, who alone answer it.
  mentions: z.array(z.string().uuid()),
  // A user's post that moves the group on to a new topic, discussed from its own first round.
  topic: z.boolean().default(false),
  // A member's post is pending while its turn runs, failed when the turn did not complete.
  state: z.enum(['pending', 'done', 'failed']).catch('done'),
  // Why a member's post failed: a reason code, then, on the lines after it, what the agent said.
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type DiscussionPost = z.infer<typeof DiscussionPost>

export const DiscussionCreate = z.object({
  title: z.string().trim().max(200).optional(),
  topic: z.string().trim().min(1).max(20000),
  requirements: z.string().trim().max(MAX_DISCUSSION_REQUIREMENTS).default(DEFAULT_DISCUSSION_REQUIREMENTS),
  projectPaths: z.array(z.string().trim().min(1)).max(MAX_TASK_REPOS),
  members: z.array(DiscussionMemberFields).min(MIN_DISCUSSION_MEMBERS).max(MAX_DISCUSSION_MEMBERS),
  // Which of members sums up.
  chair: z.number().int().nonnegative(),
  maxRounds: z.number().int().min(1).max(MAX_DISCUSSION_ROUNDS).default(DEFAULT_DISCUSSION_ROUNDS),
  anonymous: z.boolean().default(false)
}).refine((fields) => fields.chair < fields.members.length, { message: 'the chair must be one of the members' })
export type DiscussionCreate = z.input<typeof DiscussionCreate>

// pause: no new round after the turns out now; resume: go on from where it paused; nextRound: one
// more round, then the summary again; conclude: the summary once the turns out now are in; stop:
// interrupt the turns out now, and pause.
export const DiscussionAction = z.enum(['pause', 'resume', 'nextRound', 'conclude', 'stop'])
export type DiscussionAction = z.infer<typeof DiscussionAction>

export type DiscussionActionBlocker = 'not-running' | 'not-paused' | 'summing-up' | 'done'

export function checkDiscussionAction(discussion: Pick<Discussion, 'state' | 'step'>, action: DiscussionAction): DiscussionActionBlocker | null {
  const { state, step } = discussion
  const summing = step === 'summary' && (state === 'running' || state === 'pausing')
  switch (action) {
    case 'pause':
      if (summing) return 'summing-up'
      return state === 'running' ? null : 'not-running'
    case 'resume':
      return state === 'paused' || state === 'pausing' ? null : 'not-paused'
    case 'nextRound':
      return state === 'paused' || state === 'done' ? null : 'not-paused'
    case 'conclude':
      if (state === 'done') return 'done'
      return summing ? 'summing-up' : null
    case 'stop':
      return state === 'running' || state === 'pausing' ? null : 'not-running'
  }
}

export type DiscussionMemberBlocker = 'full' | 'too-few' | 'chair' | 'busy'

// A member joins up to the limit, and takes part from the next round.
export function checkAddDiscussionMember(discussion: Pick<Discussion, 'members'>): DiscussionMemberBlocker | null {
  return discussion.members.length >= MAX_DISCUSSION_MEMBERS ? 'full' : null
}

// The chair stays, as it is to sum up; a member answering is let finish first.
export function checkRemoveDiscussionMember(discussion: Pick<Discussion, 'members' | 'chairId'>, memberId: string): DiscussionMemberBlocker | null {
  if (discussion.members.length <= MIN_DISCUSSION_MEMBERS) return 'too-few'
  if (memberId === discussion.chairId) return 'chair'
  return discussion.members.find((member) => member.id === memberId)?.status === 'idle' ? null : 'busy'
}

// A new topic waits for the turns out now: the user pauses first, or lets the summary come.
export function checkNewDiscussionTopic(discussion: Pick<Discussion, 'state' | 'members'>): 'busy' | null {
  if (discussion.state === 'running' || discussion.state === 'pausing') return 'busy'
  return discussion.members.every((member) => member.status === 'idle') ? null : 'busy'
}

// A group chat is put away only once nothing is out, its members' agents then let go.
export function checkArchiveDiscussion(discussion: Pick<Discussion, 'state' | 'members'>): 'busy' | null {
  return checkNewDiscussionTopic(discussion)
}

// The topic now discussed: the last the user moved the group on to, else the one it began with.
export function currentTopic(discussion: Pick<Discussion, 'topic'>, posts: readonly Pick<DiscussionPost, 'topic' | 'text'>[]): string {
  return posts.findLast((post) => post.topic)?.text ?? discussion.topic
}

export type DiscussionProjectsBlocker = 'no-projects' | 'busy'

// Each member's agent works in the first project and is given the others as it starts, so only those
// others change, and only while every member is idle. One begun without projects works in a folder of
// Conclave's own, and stays there.
export function checkEditDiscussionProjects(discussion: Pick<Discussion, 'projectPaths' | 'members'>): DiscussionProjectsBlocker | null {
  if (discussion.projectPaths.length === 0) return 'no-projects'
  return discussion.members.every((member) => member.status === 'idle') ? null : 'busy'
}

// Parsed one by one, so a discussion a newer core describes differently drops alone.
export const DiscussionList = z.array(z.unknown()).transform((discussions) =>
  discussions.flatMap((discussion) => {
    const parsed = Discussion.safeParse(discussion)
    return parsed.success ? [parsed.data] : []
  })
)
