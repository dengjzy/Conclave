import type { CheckSpec, Task } from '@conclave/protocol'

// Synthesizes objective dynamic verification checks for tasks that carry repro commands or
// natural language verification criteria. Inspired by Karpathy's autoresearch evaluation loops.
export class DynamicHarness {
  synthesizeChecks(task: Task, fallbackRepo: string): CheckSpec[] {
    const checks: CheckSpec[] = []
    const text = task.details || task.title
    const repo = task.repos[0]?.path ?? fallbackRepo

    // Match explicit command lines indicated by $ or backticks or keywords
    const patterns = [
      /(?:^|\n)(?:Run|Verify|Check|Repro|Test|运行|验证|复现|测试)[:：]?\s*[`$]?([a-zA-Z0-9_.-]+(?:\s+[^\n`]+)?)[`$]?/gi,
      /```(?:bash|sh|shell)\n([^\n]+)\n```/gi
    ]

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const cmd = match[1]?.trim().replace(/^[$#]\s*/, '')
        if (cmd && !checks.some((c) => c.command === cmd) && isValidCommand(cmd)) {
          checks.push({
            repo,
            command: cmd,
            timeoutMs: 300_000,
            required: true
          })
        }
      }
    }

    return checks
  }
}

function isValidCommand(cmd: string): boolean {
  // Filter out comments or prose
  if (cmd.startsWith('#') || cmd.startsWith('//')) return false
  const first = cmd.split(/\s+/)[0]
  if (!first) return false
  return /^[a-zA-Z0-9_.-]+$/.test(first) && !['the', 'this', 'if', 'when', 'then', 'a', 'an'].includes(first.toLowerCase())
}
