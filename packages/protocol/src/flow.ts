import { z } from 'zod'
import { AgentKind } from './agent'
import { HiddenTestPlan } from './hidden-test'
import { Replan } from './replan'

// A flow is one autonomous run of a task: an implement node writes, a verify node runs the task's
// checks, and the task reaches review only when the flow says so. The first version is deliberately
// linear; the nodes and attempts are kept as data so a planner can grow the graph later.

export const FLOW_STATES = ['running', 'review', 'paused', 'failed', 'cancelled', 'waiting_environment'] as const
export const FlowState = z.enum(FLOW_STATES)
export type FlowState = z.infer<typeof FlowState>

export const EnvironmentDemand = z.object({
  id: z.string().uuid(),
  type: z.enum(['command', 'mcp', 'env_var', 'service']),
  target: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  suggestion: z.string().optional()
})
export type EnvironmentDemand = z.infer<typeof EnvironmentDemand>

export const FLOW_NODE_KINDS = ['plan', 'implement', 'verify', 'gate'] as const
export const FlowNodeKind = z.enum(FLOW_NODE_KINDS)
export type FlowNodeKind = z.infer<typeof FlowNodeKind>

export const FLOW_NODE_STATES = ['pending', 'running', 'done', 'failed', 'skipped'] as const
export const FlowNodeState = z.enum(FLOW_NODE_STATES)
export type FlowNodeState = z.infer<typeof FlowNodeState>

export const FlowNode = z.object({
  id: z.string().uuid(),
  key: z.string().trim().min(1).max(200),
  kind: FlowNodeKind,
  // The agent that runs an implement node; null for a check or a gate.
  agent: AgentKind.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  instruction: z.string().default(''),
  state: FlowNodeState.catch('pending'),
  conversationId: z.string().uuid().nullable(),
  attempts: z.number().int().nonnegative().default(0),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable()
})
export type FlowNode = z.infer<typeof FlowNode>

export const FlowAttempt = z.object({
  id: z.string().uuid(),
  nodeId: z.string().uuid(),
  number: z.number().int().positive(),
  state: z.enum(['running', 'done', 'failed']),
  // The agent that made this attempt; it may differ from the node's first agent after a switch.
  agent: AgentKind.nullable().default(null),
  result: z.enum(['pass', 'fail']).nullable().default(null),
  failureKind: z.enum(['compile', 'test', 'environment', 'unknown']).nullable().default(null),
  metricScore: z.number().nullable().optional(),
  signature: z.string().nullable().default(null),
  error: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable()
})
export type FlowAttempt = z.infer<typeof FlowAttempt>

export const Flow = z.object({
  id: z.string().uuid(),
  taskId: z.string(),
  state: FlowState.catch('paused'),
  nodes: z.array(FlowNode),
  attempts: z.array(FlowAttempt),
  maxAttempts: z.number().int().positive().max(20).default(3),
  // A run older than this is paused; the contract can shorten or lengthen it.
  maxWallClockMs: z.number().int().positive().max(86_400_000).default(1_800_000),
  // Agents this run may switch between, in the order given; the task's own agent is always first.
  candidates: z.array(AgentKind).default([]),
  // Acceptance tests written from the spec before the verifier runs; null when none were authored.
  hiddenTests: HiddenTestPlan.nullable().default(null),
  // pending/running while the author works; done when hiddenTests is set; failed when it gave none.
  testAuthor: z.enum(['pending', 'running', 'done', 'failed', 'skipped']).default('pending'),
  // Whether the hidden tests were shown to fail on the task's start commit before implementation.
  redFirst: z.enum(['pending', 'running', 'red', 'not-red', 'blocked', 'skipped']).default('skipped'),
  // The latest new approach, and the ones before it.
  replan: Replan.nullable().default(null),
  replans: z.array(Replan).default([]),
  // Why it paused or failed, in words the user can act on.
  note: z.string().nullable(),
  // What was tried and what happened, for a person reading a paused or finished run.
  report: z.string().nullable().default(null),
  // Structured demand for environment/tools when blocked.
  demand: EnvironmentDemand.nullable().default(null),
  // Runtime environment variables supplied during waiting_environment, merged into checks.
  env: z.record(z.string(), z.string()).optional(),
  // Best verified metric score and git commit checkpoint when contract.verification.ratchet is set.
  bestScore: z.number().nullable().optional(),
  bestCommit: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Flow = z.infer<typeof Flow>

export function flowNode(flow: Pick<Flow, 'nodes'>, key: string): FlowNode | null {
  return flow.nodes.find((node) => node.key === key) ?? null
}

export function activeFlowNode(flow: Pick<Flow, 'nodes'>): FlowNode | null {
  return flow.nodes.find((node) => node.state === 'running') ?? null
}
