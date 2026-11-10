import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckResult, HiddenTestPlan, Task } from '@conclave/protocol'
import type { HiddenTestProvider } from './hidden-test-provider'
import { RedFirstProvider } from './red-first'

describe('RedFirstProvider', () => {
  let dir: string
  let repo: string
  let task: Task
  let plan: HiddenTestPlan
  let result: CheckResult

  const hidden = (): HiddenTestProvider => ({
    runIn: async () => result
  } as unknown as HiddenTestProvider)

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-redfirst-test-'))
    repo = path.join(dir, 'repo')
    execFileSync('git', ['init', '-q', repo])
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
    const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    mkdirSync(path.join(repo, 'node_modules'))
    task = {
      id: 'task', title: 'Login', details: '', status: 'running', agent: 'claude',
      repos: [{ path: repo, worktreePath: repo, branch: 'b', startRef: null, start: { ref: 'HEAD', commit, note: null, at: 1 } }], dependsOn: []
    } as unknown as Task
    plan = { command: 'pnpm test hidden', files: [{ path: 'tests/a.test.ts', content: 'test' }], note: '', timeoutMs: 600_000 }
    result = { repo: 'hidden', command: plan.command, status: 'fail', exitCode: 1, durationMs: 1, tail: 'missing', signature: 's', failures: ['missing'], flaky: false }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('confirms a test that fails on the start commit, with dependencies linked', async () => {
    let copiedNodeModules = false
    const provider = new RedFirstProvider({
      runIn: async (worktree: string) => {
        const dir = path.join(worktree, 'node_modules')
        copiedNodeModules = existsSync(dir) && !lstatSync(dir).isSymbolicLink()
        return result
      }
    } as unknown as HiddenTestProvider)
    expect(await provider.run(task, 'c', plan)).toMatchObject({ status: 'red' })
    expect(copiedNodeModules).toBe(true)
    expect(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(1)
  })

  it('rejects a test that already passes on the start commit', async () => {
    result = { ...result, status: 'pass', exitCode: 0, failures: [] }
    const provider = new RedFirstProvider(hidden())
    expect(await provider.run(task, 'c', plan)).toMatchObject({ status: 'not-red' })
  })

  it('blocks when the task has no recorded start commit', async () => {
    task = { ...task, repos: [{ ...task.repos[0]!, start: null }] } as unknown as Task
    expect(await new RedFirstProvider(hidden()).run(task, 'c', plan)).toMatchObject({ status: 'blocked' })
  })
})
