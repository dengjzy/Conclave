import { z } from 'zod'
import { AgentKind } from './agent'
import { CheckSpec } from './contract'

export const FrictionStatus = z.enum(['open', 'doing', 'done', 'dropped'])
export type FrictionStatus = z.infer<typeof FrictionStatus>

export const FrictionItem = z.object({
  id: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  repro: z.string().trim().min(1),
  expect: z.string().trim().min(1),
  paths: z.array(z.string()).default([]),
  status: FrictionStatus.default('open'),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type FrictionItem = z.infer<typeof FrictionItem>

export const EvolutionGeneration = z.object({
  id: z.string().uuid(),
  frictionId: z.string().nullable().default(null),
  taskId: z.string(),
  flowId: z.string().uuid(),
  agent: AgentKind,
  base: z.string(),
  branch: z.string(),
  tip: z.string().nullable().default(null),
  checks: z.array(CheckSpec),
  state: z.enum(['running', 'passed', 'failed', 'merged']),
  note: z.string().nullable().default(null),
  report: z.string().nullable().default(null),
  merged: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type EvolutionGeneration = z.infer<typeof EvolutionGeneration>

export const EvolutionStatus = z.object({
  stagingBranch: z.string(),
  baseCommit: z.string(),
  activeGeneration: EvolutionGeneration.nullable().default(null),
  openFrictionCount: z.number().int().nonnegative(),
  items: z.array(FrictionItem).default([]),
  recentGenerations: z.array(EvolutionGeneration).default([])
})
export type EvolutionStatus = z.infer<typeof EvolutionStatus>
