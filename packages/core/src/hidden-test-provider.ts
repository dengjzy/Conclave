import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CheckResult, HiddenTestPlan, Task } from '@conclave/protocol'
import type { TerminalService } from './terminal-service'

type Runner = Pick<TerminalService, 'run' | 'waitForExit' | 'read' | 'kill'>

const TAIL = 4000

// Writes the authored tests into the task's worktree, runs their command, and puts the files back
// the way they were. The maker never sees them: they exist only for the length of this check.
export class HiddenTestProvider {
  constructor(private readonly terminals: Runner) {}

  async run(task: Task, conversationId: string, plan: HiddenTestPlan | null): Promise<CheckResult | null> {
    const worktree = task.repos[0]?.worktreePath ?? task.repos[0]?.path
    if (!worktree) return plan ? this.blocked(plan, '任务没有可用于放置隐藏测试的目录', Date.now()) : null
    return this.runIn(worktree, conversationId, plan)
  }

  async runIn(worktree: string, conversationId: string, plan: HiddenTestPlan | null): Promise<CheckResult | null> {
    if (!plan) return null
    const started = Date.now()
    const root = path.resolve(worktree)
    const restored: { target: string; content: string | null }[] = []
    try {
      for (const file of plan.files) {
        const target = path.resolve(root, file.path)
        const relative = path.relative(root, target)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          return this.blocked(plan, `隐藏测试路径越界：${file.path}`, started)
        }
        const previous = await readFile(target, 'utf8').catch(() => null)
        restored.push({ target, content: previous })
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.content, 'utf8')
      }
      const terminal = await this.terminals.run(conversationId, root, plan.command, { purpose: 'check', title: `hidden · ${plan.command}`.slice(0, 80) })
      const exitCode = await this.terminals.waitForExit(terminal.id, plan.timeoutMs)
      const tail = (await this.terminals.read(conversationId, terminal.id, TAIL).catch(() => null))?.output ?? ''
      if (exitCode === 0) await this.terminals.kill(terminal.id).catch(() => {})
      return {
        repo: 'hidden',
        command: plan.command,
        status: exitCode === 0 ? 'pass' : 'fail',
        exitCode,
        durationMs: Date.now() - started,
        tail,
        signature: `hidden\n${plan.command}\n${exitCode ?? 'null'}\n${tail}`,
        failures: exitCode === 0 ? [] : [exitCode === null ? '隐藏测试超时或被停止' : `隐藏测试失败：${tail.trim() || `退出码 ${exitCode}`}`],
        flaky: false
      }
    } catch (error) {
      return this.blocked(plan, `隐藏测试无法运行：${error instanceof Error ? error.message : String(error)}`, started)
    } finally {
      for (const { target, content } of restored.reverse()) {
        if (content === null) await rm(target, { force: true }).catch(() => {})
        else await writeFile(target, content, 'utf8').catch(() => {})
      }
    }
  }

  private blocked(plan: HiddenTestPlan, message: string, started: number): CheckResult {
    return {
      repo: 'hidden',
      command: plan.command,
      status: 'blocked',
      exitCode: null,
      durationMs: Date.now() - started,
      tail: message,
      signature: `hidden\n${plan.command}\nblocked\n${message}`,
      failures: [message],
      flaky: false
    }
  }
}
