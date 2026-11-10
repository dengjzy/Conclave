import { randomUUID } from 'node:crypto'
import type { FlowNode, PlanStep, Task, TaskContract } from '@conclave/protocol'

// The fallback planner is a template: one implement node with the task's own agent, one verify node
// that runs the task's checks. A plan graph adds a plan node and an implement/verify pair per step.
export function defaultPlan(task: Task, contract: TaskContract | null): { nodes: FlowNode[]; maxAttempts: number; maxWallClockMs: number } {
  const node = (key: string, kind: FlowNode['kind']): FlowNode => ({
    id: randomUUID(),
    key,
    kind,
    agent: kind === 'implement' ? task.agent : null,
    model: null,
    effort: null,
    instruction: kind === 'implement' ? (task.details.trim() || task.title) : '',
    state: 'pending',
    conversationId: null,
    attempts: 0,
    error: null,
    startedAt: null,
    endedAt: null
  })
  return {
    nodes: [node('implement', 'implement'), node('verify', 'verify')],
    maxAttempts: contract?.constraints.maxAttempts ?? 3,
    maxWallClockMs: contract?.constraints.maxWallClockMs ?? 1_800_000
  }
}


// A plan graph: the planner's steps become sequential implement/verify pairs. The first step still
// starts from the task's own prompt; later steps are sent into the same conversation. A step that
// names an agent is implemented by that agent, so one plan can split the work between them.
export function graphPlan(task: Task, contract: TaskContract | null, steps: readonly PlanStep[]): { nodes: FlowNode[]; maxAttempts: number; maxWallClockMs: number } {
  const node = (key: string, kind: FlowNode['kind'], instruction: string, agent: FlowNode['agent'] = null, state: FlowNode['state'] = 'pending'): FlowNode => ({
    id: randomUUID(), key, kind, agent: kind === 'implement' ? (agent ?? task.agent) : null, model: null, effort: null,
    instruction, state, conversationId: null, attempts: 0, error: null, startedAt: null, endedAt: null
  })
  return {
    nodes: [
      node('plan', 'plan', steps.map((step, index) => `${index + 1}. ${step.title}: ${step.instruction}`).join('\n'), null, 'done'),
      ...steps.flatMap((step, index) => [
        node(`implement-${index + 1}`, 'implement', step.instruction, step.agent),
        node(`verify-${index + 1}`, 'verify', '')
      ])
    ],
    maxAttempts: contract?.constraints.maxAttempts ?? 3,
    maxWallClockMs: contract?.constraints.maxWallClockMs ?? 1_800_000
  }
}
