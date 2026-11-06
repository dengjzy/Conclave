import type { AgentKind, ChatItem, Conversation, ConversationStage, Task } from '@conclave/protocol'
import { parseHandoffMessage } from '@conclave/protocol'
import { t } from './i18n'
import { agentLabel } from './labels'
import { stagePhase, type StagePhase, type WorkflowPhase } from './workflow-progress'

export type WorkflowEvent = {
  key: string; laneId: string; taskId: string; stageId: string | null; at: number; agent: AgentKind | null
  kind: 'stage' | 'handoff' | 'file' | 'command' | 'message' | 'question' | 'error' | 'checkpoint' | 'current'
  title: string; detail: string; phase: StagePhase | WorkflowPhase; item?: ChatItem
}
const textTitle = (text: string) => text.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').slice(0, 100) ?? ''
export function workflowItem(item: ChatItem): Pick<WorkflowEvent, 'kind' | 'title' | 'detail' | 'phase'> | null {
  switch (item.kind) {
    case 'state': case 'reasoning': case 'todos': return null
    case 'user': {
      const handoff = parseHandoffMessage(item.text)
      return { kind: handoff ? 'handoff' : 'message', title: handoff ? t('WorkflowStudio.handoff') : textTitle(item.text), detail: handoff?.note ?? item.text, phase: 'recorded' }
    }
    case 'assistant': return { kind: 'message', title: textTitle(item.text), detail: item.text, phase: item.streaming ? 'running' : 'recorded' }
    case 'tool': return { kind: item.diffs.length ? 'file' : /bash|exec|command|terminal|shell/i.test(item.name) ? 'command' : 'file', title: item.description || item.title || item.name,
      detail: [item.title, item.input, item.output, ...item.diffs.map((diff) => `${diff.path}\n${diff.patch}`)].filter(Boolean).join('\n\n'),
      phase: item.status === 'failed' || item.execution?.status === 'failed' ? 'failed' : item.status === 'running' ? 'running' : 'ended' }
    case 'approval': return { kind: 'question', title: item.title, detail: item.detail ?? '', phase: item.resolution === null ? 'awaiting' : 'recorded' }
    case 'question': return { kind: 'question', title: item.questions[0]?.question ?? t('WorkflowProcess.awaiting'), detail: item.questions.map((question) => question.question).join('\n'), phase: item.resolution === null ? 'awaiting' : 'recorded' }
    case 'notice': return { kind: item.level === 'error' ? 'error' : 'checkpoint', title: textTitle(item.text), detail: item.text, phase: item.level === 'error' ? 'failed' : 'recorded' }
    case 'usageLimit': return { kind: 'question', title: t('WorkflowStudio.usageLimit'), detail: item.message ?? '', phase: 'recorded' }
    case 'turn': return { kind: item.error ? 'error' : 'checkpoint', title: t(item.error ? 'WorkflowStudio.turnFailed' : item.state === 'interrupted' ? 'WorkflowStudio.interrupted' : 'WorkflowStudio.turnEnded'), detail: item.error ?? '', phase: item.error ? 'failed' : 'ended' }
  }
}
export function workflowEvents(task: Pick<Task, 'id' | 'agent'>, stages: readonly ConversationStage[], items: readonly ChatItem[], conversation: Conversation | undefined): WorkflowEvent[] {
  const ordered = [...stages].sort((a, b) => a.startedAt - b.startedAt)
  const agents = new Map(ordered.map((stage) => [stage.id, stage.agent]))
  const latestTools = new Map<string, ChatItem>()
  for (const item of items) if (item.kind === 'tool' && !item.background) latestTools.set(item.stageId, item)
  const events: WorkflowEvent[] = ordered.map((stage, index) => ({ key: `${task.id}/stage/${stage.id}`, laneId: task.id, taskId: task.id, stageId: stage.id, at: stage.startedAt, agent: stage.agent,
    kind: index && ordered[index - 1]?.agent !== stage.agent ? 'handoff' : 'stage', title: `${t(index && ordered[index - 1]?.agent !== stage.agent ? 'WorkflowStudio.handoff' : 'WorkflowStudio.session')} · ${agentLabel(stage.agent)}`, detail: stage.route?.name ?? '', phase: stagePhase(stage, conversation) }))
  for (const item of items) {
    const event = workflowItem(item)
    const stage = stages.find((entry) => entry.id === item.stageId)
    if (event && stage && (stage.endedAt !== null || stage.sessionId !== conversation?.sessionId) && (event.phase === 'running' || event.phase === 'awaiting')) event.phase = 'recorded'
    // Some runtimes never close native read calls. A later foreground action supersedes them.
    if (event?.phase === 'running' && item.kind === 'tool' && !item.background && (latestTools.get(item.stageId) !== item || conversation?.chat?.turn !== 'running')) event.phase = 'recorded'
    if (event) events.push({ ...event, key: `${task.id}/item/${item.stageId}/${item.id}`, laneId: task.id, taskId: task.id, stageId: item.stageId, at: item.at, agent: agents.get(item.stageId) ?? task.agent, item })
  }
  return events.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
}
export function latestWorkflowEvent(events: readonly WorkflowEvent[], laneId: string | null): WorkflowEvent | null {
  return laneId ? events.findLast((event) => event.laneId === laneId) ?? null : null
}

export function activeWorkflowEvent(events: readonly WorkflowEvent[], laneId: string | null): WorkflowEvent | null {
  const current = events.findLast((event) => event.laneId === laneId && event.kind === 'current')
  if (!current) return null
  if (current.phase !== 'running' && current.phase !== 'awaiting') return current
  return events.findLast((event) => event.laneId === laneId && event.stageId === current.stageId && event.kind !== 'stage' && event.kind !== 'handoff' && event.kind !== 'current' && event.kind !== 'message' && event.phase === (current.phase === 'awaiting' ? 'awaiting' : 'running')) ?? current
}
