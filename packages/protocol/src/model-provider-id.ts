import { z } from 'zod'

// Never renamed: agents keep it in what they record (Codex's thread names its provider by it).
export const ModelProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
export type ModelProviderId = z.infer<typeof ModelProviderId>
