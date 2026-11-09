import type { Task } from '@conclave/protocol'
import { matchesFilter, type BoardFilter, type TaskSort } from './task-board'

export type WorkflowGroup = { id: string; title: string; lanes: Task[]; total: number; updatedAt: number }

export function workflowGroups(tasks: readonly Task[], filter: BoardFilter, sort: TaskSort, abandoned: boolean): WorkflowGroup[] {
  const groups = new Map<string, WorkflowGroup>()
  for (const task of tasks) {
    if (!task.workflow) continue
    const flow = task.workflow
    let group = groups.get(flow.id)
    if (!group) {
      group = { id: flow.id, title: flow.title, lanes: [], total: 0, updatedAt: task.updatedAt }
      groups.set(flow.id, group)
    }
    group.total++
    group.updatedAt = Math.max(group.updatedAt, task.updatedAt)
    if ((abandoned || task.status !== 'abandoned') && matchesFilter(task, filter)) group.lanes.push(task)
  }
  const shown = [...groups.values()].filter((group) => group.lanes.length > 0)
  for (const group of shown) group.lanes.sort((a, b) => (a.workflow?.position ?? 0) - (b.workflow?.position ?? 0) || a.createdAt - b.createdAt)
  return shown.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'created'
    ? (b.lanes[0]?.workflow?.createdAt ?? 0) - (a.lanes[0]?.workflow?.createdAt ?? 0) : b.updatedAt - a.updatedAt)
}
