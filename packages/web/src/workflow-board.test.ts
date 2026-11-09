import { describe, expect, it } from 'vitest'
import { Task } from '@conclave/protocol'
import { workflowGroups } from './workflow-board'

const flow = { id: '00000000-0000-4000-8000-000000000001', title: 'Login', request: '', bases: [{ path: '/repo', commit: 'a'.repeat(40) }], createdAt: 1 }
const task = (id: string, position: number, patch: Partial<Task> = {}): Task => Task.parse({ id, title: id, details: '', status: 'pending', repos: [], dependsOn: [], agent: null, conversationId: null, plan: null, launch: {}, createdAt: position, updatedAt: position, workflow: { ...flow, lane: id, position }, ...patch })
const filter = { query: '', project: null, agent: null }

describe('workflow board', () => {
  it('keeps lane order stable when activity changes, grouping by identity rather than display title', () => {
    const groups = workflowGroups([task('b', 1, { updatedAt: 99 }), task('a', 0), task('other', 0, { workflow: { ...flow, id: '00000000-0000-4000-8000-000000000002', lane: 'other', position: 0 } }), task('ordinary', 0, { workflow: null })], filter, 'recent', false)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.lanes.map((lane) => lane.id)).toEqual(['a', 'b'])
  })
  it('filters visible lanes while preserving total counts and finds a renamed task by workflow title', () => {
    const lanes = [task('a', 0, { agent: 'codex' }), task('b', 1, { status: 'abandoned' })]
    const group = workflowGroups(lanes, { ...filter, query: 'Login', agent: 'codex' }, 'recent', false)[0]
    expect(group?.lanes.map((lane) => lane.id)).toEqual(['a'])
    expect(group?.total).toBe(2)
    expect(workflowGroups(lanes, filter, 'recent', true)[0]?.lanes).toHaveLength(2)
  })
})
