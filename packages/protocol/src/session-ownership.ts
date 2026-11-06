import { z } from 'zod'
import { AgentKind } from './agent'

export const NATIVE_SESSION_LOG_ENV = 'CONCLAVE_NATIVE_SESSION_LOG'
export const OwnedNativeSession = z.object({
  agent: AgentKind,
  providerSessionId: z.string().min(1),
  cwd: z.string().min(1),
  home: z.string().min(1).optional()
})
export type OwnedNativeSession = z.infer<typeof OwnedNativeSession>
