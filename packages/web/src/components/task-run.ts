import type { Flow, Task } from '@conclave/protocol'

export type RunSummary = {
  // A task that has never run still offers to start one; a finished one still shows where it went.
  visible: boolean
  canStart: boolean
  state: Flow['state'] | null
  attempts: number
  steps: number
  hiddenTests: number | null
  note: string | null
}

// What the task page says about its run, kept pure so the rules are testable without rendering.
export function runSummary(task: Task, flow: Flow | null): RunSummary {
  return {
    visible: flow !== null || task.status === 'pending',
    canStart: flow === null && task.status === 'pending',
    state: flow?.state ?? null,
    attempts: flow?.attempts.length ?? 0,
    steps: flow?.nodes.filter((node) => node.kind === 'implement').length ?? 0,
    hiddenTests: flow?.hiddenTests?.files.length ?? null,
    note: flow?.note ?? null
  }
}
