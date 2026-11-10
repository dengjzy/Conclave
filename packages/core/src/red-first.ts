import { cp, lstat, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CheckResult, HiddenTestPlan, Task } from '@conclave/protocol'
import { execFileAsync } from './hidden-exec'
import type { HiddenTestProvider } from './hidden-test-provider'

export type RedFirstResult = {
  status: 'red' | 'not-red' | 'blocked'
  result: CheckResult | null
  reason: string
}

// The dependency folders a test command needs but a fresh worktree does not carry. They are copied,
// not linked: a test that writes into one must not reach the task worktree. A very large folder is
// skipped rather than copied; the check then reports why it could not run.
const DEPENDENCIES = ['node_modules', '.venv', 'venv', 'vendor', 'target', 'Pods']
const MAX_DEPENDENCY_KB = 1_000_000

// Red-first: run the authored tests on the task's start commit, before the implementation. A test
// that passes there cannot prove the change; a test that fails there can.
export class RedFirstProvider {
  constructor(private readonly hidden: HiddenTestProvider) {}

  async run(task: Task, conversationId: string, plan: HiddenTestPlan): Promise<RedFirstResult> {
    const repo = task.repos.find((each) => !each.reference)
    const commit = repo?.start?.commit
    if (!repo || !commit) return { status: 'blocked', result: null, reason: '任务没有记录分支起点，无法做 red-first' }
    const parent = await mkdtemp(path.join(os.tmpdir(), 'conclave-redfirst-'))
    const dir = path.join(parent, 'tree')
    let added = false
    try {
      await execFileAsync('git', ['-C', repo.path, 'worktree', 'add', '--detach', dir, commit])
      added = true
      const source = repo.worktreePath ?? repo.path
      const skipped: string[] = []
      for (const name of DEPENDENCIES) {
        const from = path.join(source, name)
        if (!(await lstat(from).catch(() => null))?.isDirectory()) continue
        if (process.platform !== 'win32') {
          const size = await execFileAsync('du', ['-sk', from]).then(({ stdout }) => Number(stdout.trim().split(/\s+/)[0])).catch(() => 0)
          if (size > MAX_DEPENDENCY_KB) { skipped.push(name); continue }
        }
        await cp(from, path.join(dir, name), { recursive: true, force: true, errorOnExist: false, dereference: false }).catch(() => {})
      }
      const result = await this.hidden.runIn(dir, conversationId, plan)
      if (!result) return { status: 'blocked', result: null, reason: '隐藏测试没有运行' }
      if (result.status === 'pass') return { status: 'not-red', result, reason: '隐藏测试在起点提交上已经通过，不能证明这次改动' }
      if (result.status === 'blocked') return { status: 'blocked', result, reason: `${result.failures[0] ?? 'red-first 无法运行'}${skipped.length ? `（未复制过大的依赖目录：${skipped.join('、')}）` : ''}` }
      return { status: 'red', result, reason: '隐藏测试在起点提交上失败，红检成立' }
    } catch (error) {
      return { status: 'blocked', result: null, reason: `red-first 无法建立起点工作树：${error instanceof Error ? error.message : String(error)}` }
    } finally {
      for (const name of DEPENDENCIES) await rm(path.join(dir, name), { force: true }).catch(() => {})
      if (added) await execFileAsync('git', ['-C', repo.path, 'worktree', 'remove', dir]).catch(async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        await execFileAsync('git', ['-C', repo.path, 'worktree', 'prune']).catch(() => {})
      })
      await rm(parent, { recursive: true, force: true }).catch(() => {})
    }
  }
}
