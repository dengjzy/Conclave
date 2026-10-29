import { localized, t } from './i18n'
import { isHelper } from '@conclave/protocol'
import type { AgentKind, Conversation, Routine, ScheduledRun, SquadRun, Task } from '@conclave/protocol'
import { actionableItems, type ActionableItem, type ActionableReason, type Snapshot } from './attention'
import { runOutcomeText } from './routines'
import { openQueueRuns, scheduleState, scheduleTime, TARGET_LABEL } from './schedules'
import { waitingOn } from './task-waiting'

export type OverviewRow = {
  key: string
  kind: 'task' | 'conversation' | 'squad' | 'routine' | 'schedule'
  title: string
  agent: AgentKind | null
  projectPaths: string[]
  reason: string
  failed?: true
  detail: string
  at: number
  attention?: ActionableItem
  scheduleId?: string
  routineId?: string
  conversationId?: string
  members?: ActionableItem[]
  waits: number
}

export type OverviewInput = Snapshot & {
  schedules?: readonly ScheduledRun[]
  now: number
  includeTaskSummaries?: boolean
}

export type Overview = {
  mine: OverviewRow[]
  running: OverviewRow[]
  next: { byTime: OverviewRow[]; byCondition: OverviewRow[]; later: OverviewRow[] }
  unread: OverviewRow[]
  counts: { mine: number; running: number; next: number; unread: number }
}

const REASON_LABEL: Record<ActionableReason, string> = localized(() => ({
  awaiting: t('overview.awaitingApprovalAnswer'), crashed: t('SettingsPage.unexpectedExit'), review: t('SquadWorkPanel.awaitingReview'), reply: t('TaskAlerts.waitingForYourReply')
}))

function taskRow(task: Task): OverviewRow {
  return {
    key: `task:${task.id}`, kind: task.squadId ? 'squad' : 'task', title: task.title,
    agent: task.agent, projectPaths: task.repos.map((repo) => repo.path),
    reason: '', detail: '', at: task.updatedAt, waits: 0,
    ...(task.conversationId ? { conversationId: task.conversationId } : {})
  }
}

function conversationRow(conversation: Conversation): OverviewRow {
  return {
    key: `conversation:${conversation.id}`, kind: 'conversation', title: conversation.title,
    agent: conversation.agent, projectPaths: conversation.projectPaths, reason: '', detail: '',
    at: conversation.updatedAt, conversationId: conversation.id, waits: 0
  }
}

function routineRow(routine: Routine): OverviewRow {
  return {
    key: `routine:${routine.id}`, kind: 'routine', title: routine.title,
    agent: routine.target.agent === 'auto' ? null : routine.target.agent,
    projectPaths: routine.target.projectPaths, reason: '', detail: '', at: routine.updatedAt,
    routineId: routine.id, waits: 0,
    ...(routine.lastRun?.conversationId ? { conversationId: routine.lastRun.conversationId } : {})
  }
}

function runningMembers(run: SquadRun | undefined): number {
  return new Set(run?.works.filter((work) => work.state === 'running').map((work) => work.memberId)).size
}

function requestDetail(item: ActionableItem): string {
  const more = (item.request?.open ?? 1) - 1
  return [item.request?.title, more > 0 ? t('OverviewView.more_1303', { more: more }) : ''].filter(Boolean).join(' · ')
}

const chronological = (a: OverviewRow, b: OverviewRow) => a.at - b.at || a.key.localeCompare(b.key)

export function overview(input: OverviewInput): Overview {
  const { tasks, conversations, unseen, now } = input
  const schedules = input.schedules ?? []
  const runs = Object.values(input.squadRuns ?? {})
  const routines = new Map((input.routines ?? []).map((routine) => [routine.id, routine]))
  const latestSquadRuns = new Map<string, SquadRun>()
  const taskOwners = new Map<string, Task>()
  const routineOwners = new Map<string, string>()
  const memberIds = new Map<string, string>()
  for (const task of Object.values(tasks)) {
    if (task.conversationId) taskOwners.set(task.conversationId, task)
  }
  for (const run of runs) {
    const previous = latestSquadRuns.get(run.taskId)
    if (!previous || run.createdAt > previous.createdAt) latestSquadRuns.set(run.taskId, run)
    const task = tasks[run.taskId]
    if (run.leaderConversationId) {
      memberIds.set(run.leaderConversationId, `${run.squad.id}:${run.squad.leaderId}`)
      if (task) taskOwners.set(run.leaderConversationId, task)
    }
    for (const work of run.works) {
      if (!work.conversationId) continue
      memberIds.set(work.conversationId, `${run.squad.id}:${work.memberId}`)
      if (task) taskOwners.set(work.conversationId, task)
    }
  }
  for (const conversation of Object.values(conversations)) {
    const taskId = conversation.taskId ?? (conversation.squadRunId ? input.squadRuns?.[conversation.squadRunId]?.taskId : undefined)
    const task = taskId ? tasks[taskId] : undefined
    if (task) taskOwners.set(conversation.id, task)
    if (conversation.routineId) routineOwners.set(conversation.id, conversation.routineId)
  }
  for (const run of [...schedules, ...(input.routines ?? []).flatMap((routine) => routine.lastRun ? [routine.lastRun] : [])]) {
    const routineId = run.target.kind === 'routine' ? run.target.routineId : run.routineId
    if (routineId && run.conversationId) routineOwners.set(run.conversationId, routineId)
  }

  const rowForConversation = (conversation: Conversation): OverviewRow => {
    const routineId = routineOwners.get(conversation.id)
    const routine = routineId ? routines.get(routineId) : undefined
    if (routine) return routineRow(routine)
    const task = taskOwners.get(conversation.id)
    return task ? taskRow(task) : conversationRow(conversation)
  }
  const items = actionableItems(input, input.includeTaskSummaries ?? true)
  const groups = new Map<string, { row: OverviewRow; items: ActionableItem[] }>()
  for (const item of items) {
    const task = item.target.kind === 'task' ? tasks[item.target.id] : undefined
    const conversation = item.conversationId ? conversations[item.conversationId] : undefined
    const row = task ? taskRow(task) : conversation ? rowForConversation(conversation) : undefined
    if (!row) continue
    const group = groups.get(row.key)
    if (group) group.items.push(item)
    else groups.set(row.key, { row, items: [item] })
  }

  const mine = new Map<string, OverviewRow>()
  for (const { row, items: group } of groups.values()) {
    const first = group[0]
    if (!first) continue
    row.attention = first
    row.conversationId = first.conversationId ?? row.conversationId
    row.reason = REASON_LABEL[first.primaryReason]
    row.at = Math.max(row.at, ...group.map((item) => item.updatedAt))
    row.waits = 1
    row.detail = requestDetail(first)
    if (row.kind === 'squad') {
      const members = new Map<string, ActionableItem>()
      for (const item of group) {
        if (!item.conversationId || (item.primaryReason !== 'awaiting' && item.primaryReason !== 'reply')) continue
        const memberId = memberIds.get(item.conversationId) ?? item.conversationId
        if (!members.has(memberId)) members.set(memberId, item)
      }
      row.members = [...members.values()]
      row.waits = Math.max(1, members.size)
      const running = runningMembers(latestSquadRuns.get(first.target.id))
      const approvals = row.members.reduce((sum, member) => sum + (member.request?.kind === 'approval' ? member.request.open : 0), 0)
      const questions = row.members.filter((member) => member.request?.kind === 'question').length
      const replies = row.members.filter((member) => !member.request).length
      row.detail = [running > 0 ? t('overview.running', { running: running }) : '', approvals > 0 ? t('overview.approvalsPending', { approvals: approvals }) : '',
        questions > 0 ? t('overview.awaitingAnswers', { questions: questions }) : '', replies > 0 ? t('overview.awaitingReplies', { replies: replies }) : '',
        group.some((item) => item.reasons.includes('review')) ? t('SquadWorkPanel.awaitingReview') : ''].filter(Boolean).join(' · ')
    }
    mine.set(row.key, row)
  }

  const running = new Map<string, OverviewRow>()
  const unread = new Map<string, OverviewRow>()
  const byTime: OverviewRow[] = []
  const byCondition: OverviewRow[] = []
  const later: OverviewRow[] = []
  const tomorrow = new Date(now)
  tomorrow.setHours(0, 0, 0, 0)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const timed = (row: OverviewRow) => (row.at >= tomorrow.getTime() ? later : byTime).push(row)

  for (const routine of routines.values()) {
    const row = mine.get(`routine:${routine.id}`) ?? routineRow(routine)
    const candidates = schedules.filter((run) => (run.target.kind === 'routine' && run.target.routineId === routine.id) || run.routineId === routine.id)
    if (routine.lastRun && !candidates.some((run) => run.id === routine.lastRun?.id)) candidates.push(routine.lastRun)
    const active = candidates.filter((run) => run.status === 'starting' || (run.status === 'started' && run.finishedAt == null && run.outcome == null))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    const failed = routine.unread > 0 && (routine.lastRun?.status === 'failed' || routine.lastRun?.outcome === 'failed')
    if (failed) {
      row.failed = true
      row.reason = t('overview.runFailed')
      row.waits = Math.max(1, row.waits)
      row.detail = routine.lastRun ? runOutcomeText(routine.lastRun, now) : ''
      mine.set(row.key, row)
    } else if (active) {
      row.reason = mine.has(row.key) ? row.reason : t('ChatTodos.inProgress')
      if (!mine.has(row.key)) running.set(row.key, row)
    } else if (!mine.has(row.key) && routine.unread > 0) {
      row.reason = t('OverviewView.unread')
      row.detail = t('overview.unreadRuns', { value1: routine.unread })
      unread.set(row.key, row)
    }
    if (active) {
      row.detail = [row.detail, runOutcomeText(active, now)].filter(Boolean).join(' · ')
      row.scheduleId = active.id
      row.conversationId = active.conversationId ?? row.conversationId
    }
    if (routine.enabled && routine.nextRunAt !== null) {
      const nextDetail = t('overview.next', { value1: scheduleTime(routine.nextRunAt, now) })
      row.detail = [row.detail, nextDetail].filter(Boolean).join(' · ')
      if (!mine.has(row.key) && !running.has(row.key) && !unread.has(row.key)) {
        row.reason = t('overview.byTime')
        row.at = routine.nextRunAt
        timed(row)
      }
    }
  }

  const scheduleRow = (run: ScheduledRun): OverviewRow => {
    const task = run.target.kind === 'task' ? tasks[run.target.taskId] : undefined
    const conversationId = run.target.kind === 'conversation' || run.target.kind === 'resume' ? run.target.conversationId : run.conversationId
    const conversation = conversationId ? conversations[conversationId] : undefined
    return {
      key: `schedule:${run.id}`, kind: 'schedule', title: run.title, agent: run.agent,
      projectPaths: task?.repos.map((repo) => repo.path) ?? conversation?.projectPaths ?? [],
      reason: scheduleState(run, now), detail: TARGET_LABEL[run.target.kind], at: run.createdAt,
      scheduleId: run.id, waits: 0, ...(conversationId ? { conversationId } : {})
    }
  }
  for (const run of schedules) {
    // Automatic quota resumes are represented by their wait, not a user-created failure.
    if (run.status !== 'failed' || run.target.kind === 'routine' || run.target.kind === 'resume' || run.routineId) continue
    const row = scheduleRow(run)
    row.failed = true
    row.waits = 1
    row.at = run.settledAt ?? run.createdAt
    mine.set(row.key, row)
  }
  for (const run of openQueueRuns(schedules)) {
    if (run.routineId) continue
    const row = scheduleRow(run)
    if (run.status === 'starting') running.set(row.key, row)
    else if (run.notBefore !== null && run.notBefore > now) {
      row.at = run.notBefore
      timed(row)
    } else {
      if (run.resetsAt !== null) {
        row.at = run.resetsAt
        if (run.resetsAt <= now) row.reason += `（${scheduleTime(run.resetsAt, now)}）`
      }
      byCondition.push(row)
    }
  }
  for (const task of Object.values(tasks)) {
    const row = taskRow(task)
    if (mine.has(row.key)) continue
    if (task.status === 'running') {
      row.reason = t('ChatTodos.inProgress')
      const members = task.squadId ? runningMembers(latestSquadRuns.get(task.id)) : 0
      if (members > 0) row.detail = t('overview.running_2528', { members: members })
      running.set(row.key, row)
    } else {
      const dependencies = waitingOn(task, tasks)
      if (dependencies > 0) {
        row.reason = t('overview.waitingForDependencies', { dependencies: dependencies })
        row.detail = ''
        byCondition.push(row)
      }
    }
  }
  for (const conversation of Object.values(conversations)) {
    if (isHelper(conversation) || conversation.chat?.turn !== 'running' || taskOwners.has(conversation.id) || conversation.taskId || conversation.squadRunId || conversation.parentConversationId || conversation.discussionId || routineOwners.has(conversation.id)) continue
    const row = conversationRow(conversation)
    if (mine.has(row.key)) continue
    row.reason = t('ChatTodos.inProgress')
    running.set(row.key, row)
  }
  const upcoming = new Set([...byTime, ...byCondition, ...later].map((row) => row.key))
  for (const id of Object.keys(unseen)) {
    const conversation = conversations[id]
    if (!conversation || isHelper(conversation) || conversation.archivedAt != null || routineOwners.has(id)) continue
    const row = rowForConversation(conversation)
    if (mine.has(row.key) || running.has(row.key) || upcoming.has(row.key)) continue
    row.reason = t('OverviewView.unread')
    row.conversationId = id
    row.at = conversation.updatedAt
    const previous = unread.get(row.key)
    if (!previous || row.at > previous.at) unread.set(row.key, row)
  }

  // actionableItems already owns reason priority, including limited-core behavior.
  const order = new Map(items.map((item, index) => [item, index]))
  const mineRows = [...mine.values()].sort((a, b) => {
    const priority = (row: OverviewRow) => row.failed || !row.attention ? Infinity : order.get(row.attention) ?? Infinity
    const aPriority = priority(a)
    const bPriority = priority(b)
    if (aPriority === Infinity && bPriority === Infinity) return chronological(b, a)
    return (aPriority === bPriority ? 0 : aPriority - bPriority) || chronological(a, b)
  })
  return {
    mine: mineRows, running: [...running.values()].sort(chronological),
    next: { byTime: byTime.sort(chronological), byCondition: byCondition.sort(chronological), later: later.sort(chronological) },
    unread: [...unread.values()].sort(chronological),
    counts: { mine: mineRows.reduce((sum, row) => sum + row.waits, 0), running: running.size,
      next: byTime.length + byCondition.length + later.length, unread: unread.size }
  }
}

// What waits on the user, by kind, for the overview's head: "3 等回复 · 1 待验收".
export function waitBreakdown(rows: readonly OverviewRow[]): string {
  const counts: Record<string, number> = { [t('overview.awaitingApproval')]: 0, [t('overview.awaitingAnswer')]: 0, [t('overview.awaitingReply')]: 0, [t('SquadWorkPanel.awaitingReview')]: 0, [t('overview.error')]: 0 }
  for (const row of rows) {
    const reason = row.attention?.primaryReason
    const label = row.failed || reason === 'crashed' ? t('overview.error')
      : reason === 'awaiting' ? (row.attention?.request?.kind === 'question' ? t('overview.awaitingAnswer') : t('overview.awaitingApproval'))
      : reason === 'reply' ? t('overview.awaitingReply') : reason === 'review' ? t('SquadWorkPanel.awaitingReview') : null
    if (label) counts[label] = (counts[label] ?? 0) + row.waits
  }
  return Object.entries(counts).filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`).join(' · ')
}

// What comes due after today, a run of rows per day: 明天, then the date.
export function laterByDay(rows: readonly OverviewRow[], now: number): { day: string; rows: OverviewRow[] }[] {
  const days: { day: string; rows: OverviewRow[] }[] = []
  const today = new Date(now).setHours(0, 0, 0, 0)
  for (const row of rows) {
    const date = new Date(row.at)
    const day = Math.round((new Date(row.at).setHours(0, 0, 0, 0) - today) / 86_400_000) === 1 ? t('overview.tomorrow') : t('SourceInboxView.monthAndDay', { value1: date.getMonth() + 1, value2: date.getDate() })
    const last = days.at(-1)
    if (last?.day === day) last.rows.push(row)
    else days.push({ day, rows: [row] })
  }
  return days
}
