import path from 'node:path'
import type { CheckResult, CheckSpec, Task } from '@conclave/protocol'
import { checkTrust } from './contract-trust'
import type { TerminalService } from './terminal-service'

type Runner = Pick<TerminalService, 'run' | 'waitForExit' | 'read' | 'kill'>

const TAIL = 4000

// The generic check: a command from the task's contract, run in the task's worktree. It knows
// nothing about ADB, browsers or phones; a project script or an MCP-backed verifier supplies that.
export class CommandCheckProvider {
  constructor(private readonly terminals: Runner) {}

  // A repo's checks run in contract order: a build and a test on the same worktree must not race.
  // Different repos have their own worktrees and may run together. A stored trust hash is checked
  // first: a check file that changed since the user saved the contract cannot produce a pass.
  async run(
    task: Task,
    conversationId: string,
    checks: readonly CheckSpec[],
    trustedHash?: string,
    extraEnv?: Readonly<Record<string, string>>
  ): Promise<CheckResult[]> {
    const roots = new Map(task.repos.map((repo) => [repo.path, repo.worktreePath ?? repo.path]))
    if (trustedHash && checks.length > 0) {
      const trust = checkTrust(checks, (repo) => ({ root: roots.get(repo) ?? repo, repo }))
      if (trust.hash !== trustedHash) {
        const listed = trust.files.slice(0, 8).join('、')
        const reason = `检查文件已更改，未运行检查${listed ? `（${listed}${trust.files.length > 8 ? ' 等' : ''}）` : ''}；请重新保存契约以确认。`
        return checks.map((check) => this.blocked(check, reason, Date.now()))
      }
    }
    const groups = new Map<string, CheckSpec[]>()
    for (const check of checks) groups.set(check.repo, [...(groups.get(check.repo) ?? []), check])
    const results = await Promise.all([...groups.values()].map(async (group) => {
      const out: CheckResult[] = []
      for (const check of group) out.push(await this.runOne(roots, conversationId, check, extraEnv))
      return out
    }))
    return results.flat()
  }

  private async runOne(
    roots: ReadonlyMap<string, string>,
    conversationId: string,
    check: CheckSpec,
    extraEnv?: Readonly<Record<string, string>>
  ): Promise<CheckResult> {
    const started = Date.now()
    const root = roots.get(check.repo)
    if (!root) return this.blocked(check, '契约里的项目不在这个任务中', started)
    const cwd = check.cwd ? path.resolve(root, check.cwd) : root
    const relative = path.relative(root, cwd)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return this.blocked(check, '检查的工作目录越界', started)
    const mergedEnv = extraEnv && Object.keys(extraEnv).length > 0 ? { ...extraEnv, ...check.env } : check.env
    let exitCode: number | null = null
    let tail = ''
    try {
      const terminal = await this.terminals.run(conversationId, cwd, check.command, { purpose: 'check', env: mergedEnv, title: check.command.slice(0, 80) })
      exitCode = await this.terminals.waitForExit(terminal.id, check.timeoutMs)
      tail = (await this.terminals.read(conversationId, terminal.id, TAIL).catch(() => null))?.output ?? ''
      if (exitCode === 0) await this.terminals.kill(terminal.id).catch(() => {})
    } catch (error) {
      return this.blocked(check, `检查无法运行：${error instanceof Error ? error.message : String(error)}`, started)
    }
    const timedOut = exitCode === null
    return {
      repo: check.repo,
      command: check.command,
      required: check.required,
      status: exitCode === 0 ? 'pass' : timedOut ? 'blocked' : 'fail',
      exitCode,
      durationMs: Date.now() - started,
      tail,
      signature: `${check.repo}\n${check.command}\n${exitCode ?? 'null'}\n${tail}`,
      failures: exitCode === 0 ? [] : [timedOut ? '检查超时或被停止' : `检查失败：${tail.trim() || `退出码 ${exitCode}`}`],
      flaky: false
    }
  }

  private blocked(check: CheckSpec, reason: string, started: number): CheckResult {
    return {
      repo: check.repo,
      command: check.command,
      required: check.required,
      status: 'blocked',
      exitCode: null,
      durationMs: Date.now() - started,
      tail: reason,
      signature: `${check.repo}\n${check.command}\nblocked\n${reason}`,
      failures: [reason],
      flaky: false
    }
  }
}
