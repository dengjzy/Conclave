import { z } from 'zod'
import { jsonObjects } from './json-objects'

// Acceptance tests an author writes before seeing the implementation. They are kept as data until
// the verifier materializes them in the worktree, runs them, and puts the worktree back.
export const HiddenTestFile = z.object({
  // Relative to the task's primary worktree; absolute paths and `..` are refused.
  path: z.string().trim().min(1).max(1000),
  content: z.string().max(200_000)
})
export type HiddenTestFile = z.infer<typeof HiddenTestFile>

export const HiddenTestPlan = z.object({
  command: z.string().trim().min(1).max(2000),
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
  files: z.array(HiddenTestFile).min(1).max(20),
  note: z.string().trim().max(2000).default('')
})
export type HiddenTestPlan = z.infer<typeof HiddenTestPlan>

// A model's answer, with or without a fenced block. The last object that parses wins: a model may
// show an example before its real answer.
export function parseHiddenTestPlan(text: string): HiddenTestPlan | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? '')
  const candidates = [...fenced, ...jsonObjects(text)]
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = HiddenTestPlan.safeParse(JSON.parse(candidate))
      if (parsed.success) return parsed.data
    } catch {
      // Try the next one.
    }
  }
  return null
}
