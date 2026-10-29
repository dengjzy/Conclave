import { z } from 'zod'

export const DSH_RUNTIME_VERSION = 1
export const DSH_MODES = ['ask', 'acceptEdits', 'plan', 'readOnly', 'bypass'] as const
export const DshMode = z.enum(DSH_MODES)
export type DshMode = z.infer<typeof DshMode>
export const DSH_CONFIG_ENV = 'CONCLAVE_DSH'
export const DSH_PROVIDER_KEY_ENV = 'CONCLAVE_MODEL_PROVIDER_KEY'
export const DSH_MODE_ENV = 'CONCLAVE_DSH_MODE'

export const DshRuntimeConfig = z.object({
  mode: DshMode.default('ask'),
  lock: z.enum(['plan', 'readOnly']).nullable().default(null),
  allowBypass: z.boolean().default(false),
  workDirs: z.array(z.string()).default([]),
  noEdit: z.array(z.string()).default([]),
  readTools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  initialModel: z.object({ provider: z.string(), model: z.string() }).optional()
})
export type DshRuntimeConfig = z.infer<typeof DshRuntimeConfig>
