import type { AgentKind, Conversation, SquadMember, SquadRun, Task } from '@conclave/protocol'
import { memberProgress } from './squad-progress'
import { taskActivity } from './work-activity'
import { workflowPhase, type WorkflowPhase } from './workflow-progress'

// One line of the execution flow. A workflow lane is a task; a squad's lanes are its members,
// each with the conversation its work runs in. The flow follows these, not the parent task.
export type WorkflowLane = {
  id: string
  taskId: string
  title: string
  agent: AgentKind | null
  conversationId: string | null
  phase: WorkflowPhase
  updatedAt: number
  detail: string | null
  member?: SquadMember
  leader?: boolean
}

export function workflowLanes(
  tasks: readonly Task[],
  conversations: Readonly<Record<string, Conversation>>,
  starting: readonly string[],
  runs: Readonly<Record<string, SquadRun>>
): WorkflowLane[] {
  return tasks.map((task) => {
    const conversation = task.conversationId ? conversations[task.conversationId] : undefined
    const activity = taskActivity(task, conversations, runs)
    return {
      id: task.id,
      taskId: task.id,
      title: task.workflow?.lane ?? task.title,
      agent: task.agent,
      conversationId: task.conversationId,
      phase: workflowPhase(task, conversation, starting.includes(task.id), activity),
      updatedAt: Math.max(task.updatedAt, conversation?.updatedAt ?? 0),
      detail: activity?.detail ?? null
    }
  })
}

export function squadWorkflowLanes(task: Task, run: SquadRun, conversations: Readonly<Record<string, Conversation>>): WorkflowLane[] {
  const live = run.state === 'running' || run.state === 'paused'
  return memberProgress(run, conversations).map((progress) => {
    const conversation = progress.conversationId ? conversations[progress.conversationId] : undefined
    const latest = run.works.filter((work) => work.memberId === progress.member.id).at(-1)
    const phase = task.status === 'done' || task.status === 'review' || task.status === 'abandoned'
      ? task.status
      : !live
        ? run.state === 'review' ? 'review' : 'idle'
        : progress.state === 'awaiting' ? 'awaiting'
          : progress.state === 'running' ? 'running'
            : progress.state === 'starting' ? 'starting'
              : progress.state === 'queued' ? 'pending' : 'idle'
    return {
      id: progress.member.id,
      taskId: task.id,
      title: progress.member.name,
      agent: progress.member.agent,
      conversationId: progress.conversationId,
      phase,
      updatedAt: Math.max(progress.since ?? 0, conversation?.updatedAt ?? 0, latest?.updatedAt ?? 0) || run.updatedAt,
      detail: progress.detail,
      member: progress.member,
      leader: progress.leader
    }
  })
}
