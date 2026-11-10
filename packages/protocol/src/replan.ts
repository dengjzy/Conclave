import { z } from 'zod'
import { jsonObjects } from './json-objects'

// A new approach after an attempt failed: what the planner thinks went wrong, and what to do
// instead. It is prose for the implement agent, not a new graph yet.
export const Replan = z.object({
  diagnosis: z.string().trim().min(1).max(4000),
  instruction: z.string().trim().min(1).max(4000),
  // An optional ordered plan; the instruction stays the summary.
  steps: z.array(z.string().trim().min(1).max(2000)).max(8).default([])
})
export type Replan = z.infer<typeof Replan>

export function parseReplan(text: string): Replan | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? '')
  const candidates = [...fenced, ...jsonObjects(text)]
  for (const candidate of candidates.reverse()) {
    if (!candidate.trim()) continue
    try {
      const parsed = Replan.safeParse(JSON.parse(candidate))
      if (parsed.success) return parsed.data
    } catch {
      // Try the next.
    }
  }
  return null
}
