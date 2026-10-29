import { z } from 'zod'
import { AgentKind } from '@conclave/protocol'

// What main knows of a newer Conclave, as the renderer shows it.
export const UpdateState = z.object({
  current: z.string(),
  status: z.enum(['idle', 'checking', 'none', 'available', 'ready', 'downloading', 'installing', 'error']),
  latest: z.object({
    version: z.string(),
    notes: z.string(),
    page: z.string(),
    // The installer for this machine, opened in the browser when it cannot be installed in place.
    download: z.string().nullable()
  }).nullable(),
  // Whether main can replace this packaged macOS app or Windows installation.
  canInstall: z.boolean(),
  progress: z.number().min(0).max(1).nullable(),
  error: z.string().nullable(),
  // With error agents-running: the daemon sessions still running, for the user to deal with.
  blockers: z.array(z.object({ sessionId: z.string(), agent: AgentKind.optional() })),
  checkedAt: z.number().nullable(),
  automatic: z.boolean().default(true),
  prerelease: z.boolean(),
  skipped: z.string().nullable()
})
export type UpdateState = z.infer<typeof UpdateState>

type Version = { core: [number, number, number]; pre: string[] }

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

// Semantic version order: a pre-release sorts before its release, numeric identifiers by value.
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index++) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  if (left.pre.length === 0 || right.pre.length === 0) return Math.sign(right.pre.length - left.pre.length)
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xs = /^\d+$/.test(x)
    const ys = /^\d+$/.test(y)
    if (xs && ys) return Math.sign(Number(x) - Number(y))
    if (xs !== ys) return xs ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

export function isVersion(text: string): boolean {
  return parseVersion(text) !== null
}
