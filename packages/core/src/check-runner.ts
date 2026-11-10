import type { CheckResult, HiddenTestPlan, Task, TaskContract } from '@conclave/protocol'
import type { CommandCheckProvider } from './command-check'
import type { HiddenTestProvider } from './hidden-test-provider'
import type { WorktreeSetup } from './worktree-setup'

// Which checks a task runs: the commands in its contract, or, when it names none, the project's own
// check. Device and browser work belongs to a project script or an MCP-backed verifier; this only
// runs commands, times them out, captures their output and keeps their stable signature.
export class CheckRunner {
  constructor(
    private readonly commands: CommandCheckProvider,
    private readonly setup: Pick<WorktreeSetup, 'checkDetailed'>,
    private readonly hidden: HiddenTestProvider
  ) {}

  async run(task: Task, conversationId: string, contract: TaskContract | null, hiddenTests: HiddenTestPlan | null = null): Promise<CheckResult[] | null> {
    const checks = contract?.verification.checks ?? []
    const base = checks.length > 0
      ? await this.commands.run(task, conversationId, checks, contract?.verification.trustedHash)
      : await this.setup.checkDetailed(conversationId, task.repos.map((repo) => ({ path: repo.path, dir: repo.worktreePath ?? repo.path })))
    const hidden = await this.hidden.run(task, conversationId, hiddenTests)
    const all = [...(base ?? []), ...(hidden ? [hidden] : [])]
    return all.length > 0 ? all : null
  }
}
