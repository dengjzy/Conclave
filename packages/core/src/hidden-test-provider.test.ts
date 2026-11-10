import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HiddenTestPlan, Task, Terminal } from '@conclave/protocol'
import { HiddenTestProvider } from './hidden-test-provider'
import type { TerminalService } from './terminal-service'

describe('HiddenTestProvider', () => {
  let dir: string
  let task: Task
  let plan: HiddenTestPlan
  let code: number | null
  let output: string
  let ran: string[]
  let provider: HiddenTestProvider

  const terminals = {
    run: async (_conversationId: string, _cwd: string, command: string): Promise<Terminal> => {
      ran.push(command)
      return { id: command, sessionId: command, cwd: dir, title: command, createdAt: 0, conversationId: 'c', command }
    },
    waitForExit: async () => code,
    read: async (_conversationId: string, id: string) => ({ id, command: id, output, truncated: false, running: false, exitCode: code }),
    kill: async () => {}
  } as unknown as TerminalService

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-hidden-'))
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src', 'existing.ts'), 'export const existing = 1\n')
    task = {
      id: 'task', title: 'Login', details: '', status: 'running', repos: [{ path: dir, worktreePath: dir, branch: 'b', startRef: null, start: null }],
      dependsOn: [], agent: 'claude'
    } as unknown as Task
    plan = { command: 'pnpm test hidden', files: [{ path: 'src/existing.ts', content: 'hidden' }, { path: 'tests/login.test.ts', content: 'test' }], note: '', timeoutMs: 600_000 }
    code = 0
    output = 'ok'
    ran = []
    provider = new HiddenTestProvider(terminals)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the tests, runs the command, and restores the worktree', async () => {
    const result = await provider.run(task, 'c', plan)
    expect(result).toMatchObject({ status: 'pass', exitCode: 0, failures: [] })
    expect(ran).toEqual(['pnpm test hidden'])
    expect(readFileSync(path.join(dir, 'src', 'existing.ts'), 'utf8')).toBe('export const existing = 1\n')
    expect(existsSync(path.join(dir, 'tests', 'login.test.ts'))).toBe(false)
  })

  it('keeps the failure output when the hidden test fails', async () => {
    code = 1
    output = 'AssertionError: login failed'
    const result = await provider.run(task, 'c', plan)
    expect(result).toMatchObject({ status: 'fail', exitCode: 1 })
    expect(result?.failures[0]).toContain('AssertionError')
  })

  it('reports a timeout as a failure', async () => {
    code = null
    const result = await provider.run(task, 'c', plan)
    expect(result).toMatchObject({ status: 'fail', exitCode: null })
    expect(result?.failures[0]).toContain('超时')
  })

  it('refuses a path outside the worktree', async () => {
    plan = { ...plan, files: [{ path: '../outside.ts', content: 'x' }] }
    const result = await provider.run(task, 'c', plan)
    expect(result?.status).toBe('blocked')
    expect(result?.failures[0]).toContain('越界')
    expect(ran).toHaveLength(0)
  })

  it('does nothing without a plan', async () => {
    expect(await provider.run(task, 'c', null)).toBeNull()
  })
})
