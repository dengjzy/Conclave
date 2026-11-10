import type { CheckResult, Flow } from '@conclave/protocol'

export type FailureKind = 'compile' | 'test' | 'environment' | 'unknown'

// A check's text is the only thing the engine has to go on. The classes are deliberately coarse:
// they decide whether to retry the same agent, switch, or stop, not what the bug is.
export function classifyFailure(results: readonly CheckResult[]): FailureKind {
  if (results.some((result) => result.status === 'blocked')) return 'environment'
  const text = results.map((result) => `${result.failures.join('\n')}\n${result.tail}`).join('\n').toLowerCase()
  if (/enoent|command not found|permission denied|eaddrinuse|econnrefused|network|timed out|timeout/.test(text)) return 'environment'
  if (/error ts\d|syntaxerror|compilation|build failed|cannot find module|type error|\btsc\b/.test(text)) return 'compile'
  if (/assertion|expect\(|failing|failed|failure|test|spec/.test(text)) return 'test'
  return 'unknown'
}

// A failure that repeats with the same output is not progress; retrying it again is just spending.
export function failureSignature(results: readonly CheckResult[]): string {
  return results.map((result) => result.signature || `${result.repo}\n${result.command}\n${result.exitCode ?? 'null'}`).join('|')
}

// The last few attempts, in the order they happened. A retry prompt carries this so the next agent
// can avoid repeating a dead end rather than seeing only the newest failure.
export function attemptHistory(flow: Pick<Flow, 'attempts'>, limit = 5): string {
  return flow.attempts.slice(-limit).map((attempt) => {
    const outcome = attempt.result ?? attempt.state
    const kind = attempt.failureKind ? ` · ${attempt.failureKind}` : ''
    return `#${attempt.number} ${attempt.agent ?? '—'} · ${outcome}${kind}`
  }).join('\n')
}
