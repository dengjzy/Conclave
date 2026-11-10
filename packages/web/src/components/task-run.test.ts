import { describe, expect, it } from 'vitest'
import type { Flow, Task } from '@conclave/protocol'
import { runSummary } from './task-run'

describe('runSummary', () => {
  const task = { id: 't', title: 'Add a filter', status: 'pending' } as unknown as Task
  const flow = {
    state: 'paused',
    note: '测试未通过',
    attempts: [{ id: 'a' }, { id: 'b' }],
    nodes: [
      { kind: 'plan' }, { kind: 'implement' }, { kind: 'verify' },
      { kind: 'implement' }, { kind: 'verify' }
    ],
    hiddenTests: { files: [{ path: 'a.test.ts' }] }
  } as unknown as Flow

  it('offers to start a run for a pending task that has none', () => {
    expect(runSummary(task, null)).toEqual({ visible: true, canStart: true, state: null, attempts: 0, steps: 0, hiddenTests: null, note: null })
  })

  it('shows the run once it exists, even when the task has left pending', () => {
    const review = { ...task, status: 'review' } as Task
    expect(runSummary(review, flow)).toEqual({
      visible: true, canStart: false, state: 'paused', attempts: 2, steps: 2, hiddenTests: 1, note: '测试未通过'
    })
  })

  it('stays out of the way for a finished task that never ran', () => {
    expect(runSummary({ ...task, status: 'done' } as Task, null).visible).toBe(false)
  })
})
