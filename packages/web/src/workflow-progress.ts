import type { Conversation, ConversationStage, Task } from '@conclave/protocol'
import type { WorkActivity } from './work-activity'

export type WorkflowPhase = 'pending' | 'starting' | 'running' | 'awaiting' | 'idle' | 'review' | 'done' | 'abandoned' | 'failed'
export type StagePhase = 'recorded' | 'ended' | 'failed' | 'running' | 'awaiting' | 'idle'

export function workflowPhase(task: Task, conversation: Conversation | undefined, starting: boolean, activity: WorkActivity | null): WorkflowPhase {
  if (task.status === 'done' || task.status === 'abandoned' || task.status === 'review') return task.status
  if (activity) return activity.state
  if (starting || conversation?.starting) return 'starting'
  if (!conversation?.sessionId && conversation?.lastExit?.code != null && conversation.lastExit.code !== 0) return 'failed'
  return task.status === 'pending' ? 'pending' : 'idle'
}

export function stagePhase(stage: ConversationStage, conversation: Conversation | undefined): StagePhase {
  if (stage.exitCode != null && stage.exitCode !== 0) return 'failed'
  if (stage.endedAt !== null) return 'ended'
  if (stage.sessionId && stage.sessionId === conversation?.sessionId) {
    return conversation.chat?.turn === 'running' ? 'running' : conversation.chat?.turn === 'awaiting' ? 'awaiting' : 'idle'
  }
  return 'recorded'
}

const priority = (phase: WorkflowPhase): number => phase === 'awaiting' ? 3 : phase === 'running' ? 2 : phase === 'starting' ? 1 : 0

// A lane that just spoke takes the camera, but a burst of tokens in another lane must not make it
// jump back and forth. The lane already in view keeps it until another is clearly newer.
const SWITCH_MS = 1500

export function followWorkflowLane(lanes: readonly { id: string; phase: WorkflowPhase; updatedAt?: number }[], current: string | null): string | null {
  const active = lanes.filter((lane) => priority(lane.phase) > 0)
  if (!active.length) return null
  const highest = Math.max(...active.map((lane) => priority(lane.phase)))
  const candidate = active.filter((lane) => priority(lane.phase) === highest)
  const newest = Math.max(...candidate.map((lane) => lane.updatedAt ?? 0))
  const shown = candidate.find((lane) => lane.id === current)
  if (shown?.phase === 'awaiting') return newest > (shown.updatedAt ?? 0) ? candidate.find((lane) => (lane.updatedAt ?? 0) === newest)?.id ?? shown.id : shown.id
  if (shown && newest - (shown.updatedAt ?? 0) < SWITCH_MS) return shown.id
  return candidate.reduce((best, lane) => (lane.updatedAt ?? 0) > (best.updatedAt ?? 0) ? lane : best).id
}
