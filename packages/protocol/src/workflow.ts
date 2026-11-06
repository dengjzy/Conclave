import { z } from 'zod'
import { AgentKind } from './agent'

export const MAX_WORKFLOW_LANES = 12
export const WorkflowLaneFields = z.object({
  name: z.string().trim().min(1).max(60),
  agent: AgentKind.nullable(),
  instructions: z.string().max(20_000).optional()
})
export const WorkflowFields = z.object({
  title: z.string().trim().min(1).max(120),
  details: z.string().max(80_000),
  repos: z.array(z.string().trim().min(1)).min(1).max(10),
  lanes: z.array(WorkflowLaneFields).min(1).max(MAX_WORKFLOW_LANES)
}).refine(({ lanes }) => new Set(lanes.map((lane) => lane.name.toLowerCase())).size === lanes.length, { message: '车道名称不能重复', path: ['lanes'] })

// Each lane remains an ordinary task: it keeps its chat, worktrees and review rules.
export const TaskWorkflow = z.object({
  id: z.string().uuid(),
  title: z.string().max(120),
  request: z.string().max(80_000),
  lane: z.string().max(60),
  position: z.number().int().nonnegative(),
  bases: z.array(z.object({ path: z.string(), commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) })).min(1).max(10),
  createdAt: z.number()
})
export type TaskWorkflow = z.infer<typeof TaskWorkflow>
