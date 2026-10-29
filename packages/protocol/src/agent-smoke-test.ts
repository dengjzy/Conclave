import { z } from 'zod'
import { AgentKind } from './agent'

export const AgentSmokeTestCheck = z.object({
  id: z.enum(['cli', 'auth', 'protocol']),
  name: z.string(),
  status: z.enum(['ok', 'warn', 'error', 'skipped']),
  message: z.string(),
  latencyMs: z.number().optional()
})
export type AgentSmokeTestCheck = z.infer<typeof AgentSmokeTestCheck>

export const AgentSmokeTestReport = z.object({
  agent: AgentKind,
  name: z.string(),
  installed: z.boolean(),
  ok: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  checks: z.array(AgentSmokeTestCheck),
  testedAt: z.number()
})
export type AgentSmokeTestReport = z.infer<typeof AgentSmokeTestReport>

export const AgentSmokeTestResult = z.object({
  reports: z.array(AgentSmokeTestReport),
  testedAt: z.number()
})
export type AgentSmokeTestResult = z.infer<typeof AgentSmokeTestResult>
