import { z } from 'zod'
import { skillRepositoryUrl, type SkillSearchResult } from '@conclave/protocol'
import { Rejection } from './rejection'

// Discovery on top of the open skills.sh registry. Conclave still installs a whole git repository
// pinned to a commit, so this only finds the repository a skill lives in; it never installs a
// skill on its own. The public search endpoint needs no key (the /api/v1 leaderboard does).
const ENDPOINT = 'https://skills.sh/api/search'
const TIMEOUT_MS = 10_000
const LIMIT = 40

// skills.sh returns a skill per repository path; `source` is the GitHub `owner/repo` it came from.
const Response = z.object({
  skills: z.array(z.object({
    source: z.string(),
    skillId: z.string().optional(),
    name: z.string().optional(),
    installs: z.number().optional()
  })).optional()
})

// A clean GitHub owner/repo, so building its URL cannot smuggle a path, query or another host.
const SOURCE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export async function searchSkills(query: string): Promise<SkillSearchResult[]> {
  const url = new URL(ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(LIMIT))
  let response: globalThis.Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new Rejection('skills-search-failed', '连不上技能市场，检查网络后重试')
  }
  if (!response.ok) throw new Rejection('skills-search-failed', `技能市场返回 ${response.status}`)
  const parsed = Response.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new Rejection('skills-search-failed', '技能市场返回的内容无法识别')
  return groupBySource(parsed.data.skills ?? [])
}

// One row per repository: several matched skills in the same repo collapse, since one install
// brings the whole repository. Order keeps the registry's, which is by popularity.
function groupBySource(skills: readonly { source: string; skillId?: string; name?: string; installs?: number }[]): SkillSearchResult[] {
  const bySource = new Map<string, SkillSearchResult>()
  for (const skill of skills) {
    if (!SOURCE.test(skill.source)) continue
    const url = skillRepositoryUrl(`https://github.com/${skill.source}`)
    const name = skill.skillId ?? skill.name
    const existing = bySource.get(url)
    if (existing) {
      if (name && !existing.skills.includes(name)) existing.skills.push(name)
      existing.installs = Math.max(existing.installs, skill.installs ?? 0)
    } else {
      bySource.set(url, { url, source: new URL(url).pathname.slice(1), skills: name ? [name] : [], installs: skill.installs ?? 0 })
    }
  }
  return [...bySource.values()]
}
