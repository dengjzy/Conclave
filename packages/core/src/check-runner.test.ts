import { beforeEach, describe, expect, it } from 'vitest'
import { TaskContractFields, type CheckResult, type Task, type TaskContract } from '@conclave/protocol'
import { CheckRunner } from './check-runner'
import type { CommandCheckProvider } from './command-check'
import type { HiddenTestProvider } from './hidden-test-provider'

describe('CheckRunner', () => {
  const task = {
    id: 't', title: '', details: '', status: 'running', repos: [{ path: '/code', worktreePath: '/wt', branch: 'b', startRef: null, start: null }],
    dependsOn: [], agent: 'claude'
  } as unknown as Task
  const pass: CheckResult[] = [{ repo: '/code', command: 'check', status: 'pass', exitCode: 0, durationMs: 1, tail: '', signature: 'ok', failures: [], flaky: false }]
  const commands = { calls: 0, run: async () => { commands.calls++; return pass } } as unknown as CommandCheckProvider & { calls: number }
  const hidden = { calls: 0, run: async () => { hidden.calls++; return null } } as unknown as HiddenTestProvider & { calls: number }
  const setup = { calls: 0, checkDetailed: async () => { setup.calls++; return pass } }

  beforeEach(() => { commands.calls = 0; setup.calls = 0; hidden.calls = 0 })

  it('runs the project check for a command contract', async () => {
    const runner = new CheckRunner(commands, setup, hidden)
    const contract: TaskContract = { ...TaskContractFields.parse({}), updatedAt: 0 }
    expect(await runner.run(task, 'c', contract)).toEqual(pass)
    expect(setup.calls).toBe(1)
    expect(commands.calls).toBe(0)
  })

  it('runs the contract checks instead of the project check', async () => {
    const runner = new CheckRunner(commands, setup, hidden)
    const contract: TaskContract = {
      ...TaskContractFields.parse({ verification: { checks: [{ repo: '/code', command: 'pnpm test', timeoutMs: 600000, required: true }] } }),
      updatedAt: 0
    }
    expect(await runner.run(task, 'c', contract)).toEqual(pass)
    expect(commands.calls).toBe(1)
    expect(setup.calls).toBe(0)
  })
})
