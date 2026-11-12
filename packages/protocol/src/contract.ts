import { z } from 'zod'

// What "done" means for one task, before an agent starts. The scheduler runs the checks; the
// contract says which ones count, what a person still has to judge, and what was already broken.

export const CheckSpec = z.object({
  // The repo path the user picked, not its worktree.
  repo: z.string().trim().min(1),
  command: z.string().trim().min(1).max(2000),
  // Relative to the repo's task worktree; the worktree root when omitted.
  cwd: z.string().trim().min(1).max(1000).optional(),
  // Extra environment for this command only; secrets should come from the project or MCP, not here.
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
  required: z.boolean().default(true)
})
export type CheckSpec = z.infer<typeof CheckSpec>

export const CheckStatus = z.enum(['pass', 'fail', 'blocked', 'skipped'])
export type CheckStatus = z.infer<typeof CheckStatus>

// One check's outcome. `failures` are the lines a person or an agent can act on; `tail` keeps the
// end of the output the terminal showed, which may be longer than the failures.
export const CheckResult = z.object({
  repo: z.string(),
  command: z.string(),
  // Optional checks still report their result but do not block a hand-in.
  required: z.boolean().optional(),
  status: CheckStatus,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  tail: z.string().default(''),
  // Stable across runs: the repo, command, exit code and output, without a terminal's own id.
  // A baseline keeps these, not the human-readable failures below.
  signature: z.string().default(''),
  failures: z.array(z.string()).default([]),
  flaky: z.boolean().default(false)
})
export type CheckResult = z.infer<typeof CheckResult>

export const RatchetDirection = z.enum(['maximize', 'minimize'])
export type RatchetDirection = z.infer<typeof RatchetDirection>

export const RatchetPlan = z.object({
  direction: RatchetDirection.default('maximize'),
  target: z.number().nullable().default(null)
})
export type RatchetPlan = z.infer<typeof RatchetPlan>

// The task-specific part of a contract: which checks run, which criteria a person keeps, what the
// plan still does not know, and which failures were there before the task started.
export const VerificationPlan = z.object({
  version: z.number().int().positive().default(1),
  checks: z.array(CheckSpec).default([]),
  criteria: z.array(z.string().trim().min(1).max(2000)).default([]),
  human: z.array(z.string().trim().min(1).max(2000)).default([]),
  unknowns: z.array(z.string().trim().min(1).max(2000)).default([]),
  baseline: z.array(z.string()).default([]),
  autonomy: z.enum(['auto', 'confirm', 'human-only']).default('confirm'),
  ratchet: RatchetPlan.nullable().optional(),
  // sha256 of the checks and the files they run, taken when the user saves the contract. Absent on
  // contracts saved before this existed, which keeps running as they did.
  trustedHash: z.string().trim().min(1).optional()
})
export type VerificationPlan = z.infer<typeof VerificationPlan>

export const TaskContractFields = z.object({
  goal: z.string().trim().max(10000).default(''),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
  autonomy: z.enum(['auto', 'confirm', 'human-only']).default('confirm'),
  verification: VerificationPlan.default({
    version: 1,
    checks: [],
    criteria: [],
    human: [],
    unknowns: [],
    baseline: [],
    autonomy: 'confirm'
  }),
  constraints: z.object({
    // Paths an agent must not change, relative to a repo or absolute.
    forbiddenPaths: z.array(z.string().trim().min(1).max(1000)).default([]),
    // A node gives up after this many attempts.
    maxAttempts: z.number().int().positive().max(20).default(3),
    // A whole run gives up after this long.
    maxWallClockMs: z.number().int().positive().max(86_400_000).default(1_800_000)
  }).default({ forbiddenPaths: [], maxAttempts: 3, maxWallClockMs: 1_800_000 })
})
export type TaskContractFields = z.input<typeof TaskContractFields>

export const TaskContract = TaskContractFields.extend({
  updatedAt: z.number()
})
export type TaskContract = z.infer<typeof TaskContract>

// A contract with no machine check can still be run, but only a person can accept it. The scheduler
// uses this to decide whether it may submit on its own.
export function contractNeedsHuman(contract: Pick<TaskContract, 'verification'>): boolean {
  return contract.verification.checks.length === 0 || contract.verification.autonomy === 'human-only'
}

// The failures this run introduced: what the contract already had is not the task's fault. Compared
// as whole lines, so a flaky test that changes its wording still shows up as new.
export function newCheckFailures(results: readonly CheckResult[], baseline: readonly string[] = []): string[] {
  const known = new Set(baseline)
  return results.filter((result) => result.required !== false && result.status !== 'pass' && !known.has(result.signature)).flatMap((result) => result.failures)
}
