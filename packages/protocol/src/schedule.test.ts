import { describe, expect, it } from 'vitest'
import { checkAutoRun, limitOf, ScheduledRunList } from './schedule'
import { Task } from './task'

const run = {
  id: '00000000-0000-4000-8000-000000000001',
  target: { kind: 'task', taskId: 't1' },
  title: 'Night',
  agent: 'claude',
  notBefore: null,
  resetsAt: null,
  status: 'waiting',
  conversationId: null,
  attempts: 0,
  error: null,
  createdAt: 0,
  settledAt: null
}

describe('checkAutoRun', () => {
  const ready = () => Task.parse({ id: 'next', title: 'Next', details: '', status: 'pending', repos: [{ path: '/code/app', worktreePath: null, branch: null }], agent: 'claude', dependsOn: ['first'], createdAt: 0, updatedAt: 0 })

  it('can arm a pending task, including one with a saved planning conversation', () => {
    expect(checkAutoRun(ready())).toBeNull()
    expect(checkAutoRun({ ...ready(), conversationId: 'planning' })).toBeNull()
  })

  it('requires dependencies, a project, and an unattended Agent', () => {
    expect(checkAutoRun({ ...ready(), dependsOn: [] })).toBe('missing-dependencies')
    expect(checkAutoRun({ ...ready(), repos: [] })).toBe('missing-repo')
    expect(checkAutoRun({ ...ready(), agent: null })).toBe('missing-agent')
    expect(checkAutoRun({ ...ready(), agent: 'cursor' })).toBe('agent-unattended-unsupported')
    expect(checkAutoRun({ ...ready(), squadId: 'squad' })).toBe('squad-schedule-unsupported')
  })

  it.each(['running', 'review', 'done', 'abandoned'] as const)('does not arm a %s task', (status) => {
    expect(checkAutoRun({ ...ready(), status })).toBe('not-pending')
  })

  it('keeps the automatic trigger when reading queue rows from core', () => {
    expect(ScheduledRunList.parse([{ ...run, target: { kind: 'task', taskId: 'next', afterDependencies: true } }])[0]?.target)
      .toEqual({ kind: 'task', taskId: 'next', afterDependencies: true })
  })
})

describe('ScheduledRunList', () => {
  it('drops a run with a target this client does not know, and keeps the rest', () => {
    const unknown = { ...run, id: '00000000-0000-4000-8000-000000000002', target: { kind: 'telepathy', conversationId: 'x' } }
    expect(ScheduledRunList.parse([run, unknown]).map((each) => each.id)).toEqual([run.id])
  })

  it("reads a routine's run, with an outcome it does not know as none", () => {
    const routineRun = {
      ...run, id: '00000000-0000-4000-8000-000000000003', target: { kind: 'routine', routineId: '00000000-0000-4000-8000-000000000009' },
      routineId: '00000000-0000-4000-8000-000000000009', dueAt: 5, finishedAt: 9, outcome: 'ascended', seenAt: null
    }
    expect(ScheduledRunList.parse([routineRun])).toEqual([expect.objectContaining({ id: routineRun.id, dueAt: 5, finishedAt: 9, outcome: null, seenAt: null })])
  })
})

describe('limitOf', () => {
  it('names the limit a resume answers, or the one a conversation run took over', () => {
    const limit = { stageId: 's', itemId: 'limit:1' }
    expect(limitOf({ kind: 'resume', conversationId: '00000000-0000-4000-8000-000000000003', ...limit })).toEqual(limit)
    expect(limitOf({ kind: 'conversation', conversationId: '00000000-0000-4000-8000-000000000003', text: '', resumes: limit })).toEqual(limit)
    expect(limitOf({ kind: 'conversation', conversationId: '00000000-0000-4000-8000-000000000003', text: '' })).toBeNull()
    expect(limitOf({ kind: 'task', taskId: 't' })).toBeNull()
  })
})
