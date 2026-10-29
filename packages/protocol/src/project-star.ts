import { z } from 'zod'
import { SourceId } from './source'

export const PROJECT_GITHUB_REPOSITORY = 'dengjzy/Conclave'
export const PROJECT_GITHUB_URL = `https://github.com/${PROJECT_GITHUB_REPOSITORY}`

export const ProjectStarIdentity = z.object({
  source: z.enum(['gh', 'github-plugin']),
  instance: SourceId.nullable(),
  account: z.string().min(1).max(100)
}).refine((identity) => identity.source === 'gh' ? identity.instance === null : identity.instance !== null)
export type ProjectStarIdentity = z.infer<typeof ProjectStarIdentity>

export const ProjectStarStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable') }),
  z.object({ state: z.literal('ready'), identity: ProjectStarIdentity, starred: z.boolean() })
])
export type ProjectStarStatus = z.infer<typeof ProjectStarStatus>

export const ProjectStarResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), problem: z.enum(['unavailable', 'permission-denied', 'account-changed', 'request-failed']) })
])
export type ProjectStarResult = z.infer<typeof ProjectStarResult>
