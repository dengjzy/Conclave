import { describe, expect, it } from 'vitest'
import type { Task } from '@conclave/protocol'
import { DynamicHarness } from './dynamic-harness'

describe('DynamicHarness', () => {
  const harness = new DynamicHarness()

  it('extracts command checks from explicit keywords in task details', () => {
    const task = {
      id: 'task-1',
      title: 'Fix server startup',
      details: 'Repro: node scripts/self-smoke.mjs\nExpect: boots cleanly',
      repos: [{ path: '/repo' }]
    } as unknown as Task

    const checks = harness.synthesizeChecks(task, '/fallback')
    expect(checks).toHaveLength(1)
    expect(checks[0]?.command).toBe('node scripts/self-smoke.mjs')
    expect(checks[0]?.repo).toBe('/repo')
  })

  it('extracts command checks from bash code blocks', () => {
    const task = {
      id: 'task-2',
      title: 'Run test suite',
      details: 'Please ensure this passes:\n```bash\npnpm test:smoke\n```',
      repos: [{ path: '/my-project' }]
    } as unknown as Task

    const checks = harness.synthesizeChecks(task, '/fallback')
    expect(checks).toHaveLength(1)
    expect(checks[0]?.command).toBe('pnpm test:smoke')
  })
})
