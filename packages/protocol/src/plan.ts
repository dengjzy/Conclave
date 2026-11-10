import { z } from 'zod'
import { AgentKind } from './agent'
import { jsonObjects } from './json-objects'

// A task decomposed into a small number of implementation steps. The flow turns each into an
// implement/verify pair; a step's instruction is what the agent is asked to do next.
export const PlanStep = z.object({
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(4000),
  // The agent the planner suggests for this step. Core keeps it only for an agent it can start
  // for writing; anything else falls back to the task's own agent.
  agent: AgentKind.nullable().catch(null).default(null)
})
export type PlanStep = z.infer<typeof PlanStep>

export const FlowPlan = z.object({ steps: z.array(PlanStep).min(1).max(8) })
export type FlowPlan = z.infer<typeof FlowPlan>

export function parseFlowPlan(text: string): FlowPlan | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? '')
  const candidates = [...fenced, ...jsonObjects(text)]
  for (const candidate of candidates.reverse()) {
    if (!candidate.trim()) continue
    try {
      const parsed = FlowPlan.safeParse(JSON.parse(candidate))
      if (parsed.success) return parsed.data
    } catch {
      // Try the next object.
    }
  }
  return null
}
