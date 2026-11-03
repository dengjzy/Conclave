import { z } from 'zod'

// This optional public-data adapter sends no credentials and is only called on explicit request.
const Pull = z.object({ title: z.string().max(1000), state: z.enum(['open', 'closed']), merged: z.boolean(), draft: z.boolean().optional(), head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }) })
const Status = z.object({ state: z.string().max(50), total_count: z.number().int().nonnegative(), statuses: z.array(z.object({ context: z.string().max(500), state: z.string().max(50) })).max(100) })
const Checks = z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(z.object({ name: z.string().max(500), status: z.string().max(50), conclusion: z.string().max(50).nullable() })).max(100) })
const Reviews = z.array(z.object({ user: z.object({ login: z.string().max(100) }).nullable(), state: z.string().max(100) })).max(100)

export type PullReference = { owner: string; repo: string; number: string; url: string }
export type PullData = { reference: PullReference; pull: z.infer<typeof Pull>; status: z.infer<typeof Status> | null; checks: z.infer<typeof Checks> | null; reviews: z.infer<typeof Reviews> | null; fetchedAt: number }

export function pullReference(input: string): PullReference | null {
  try {
    const url = new URL(input.trim())
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,9})\/?$/.exec(url.pathname)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match) return null
    const [, owner, repo, number] = match
    if (!owner || !repo || !number || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
    return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` }
  } catch { return null }
}

export async function readPull(reference: PullReference, signal: AbortSignal, request: typeof fetch = fetch): Promise<PullData> {
  const base = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await request(`${base}${path}`, { signal: timeout, credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
    return schema.parse(await response.json())
  }
  const pull = await get(`/pulls/${reference.number}`, Pull)
  const [status, checks, reviews] = await Promise.allSettled([
    get(`/commits/${pull.head.sha}/status?per_page=100`, Status),
    get(`/commits/${pull.head.sha}/check-runs?per_page=100`, Checks),
    get(`/pulls/${reference.number}/reviews?per_page=100`, Reviews)
  ])
  if (timeout.aborted) throw new DOMException('Aborted', 'AbortError')
  return { reference, pull, status: status.status === 'fulfilled' ? status.value : null, checks: checks.status === 'fulfilled' ? checks.value : null, reviews: reviews.status === 'fulfilled' ? reviews.value : null, fetchedAt: Date.now() }
}
