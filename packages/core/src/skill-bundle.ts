import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { CommitSha, SkillName, SkillRepoId, type SkillRef, type SkillRepo } from '@conclave/protocol'
import { Rejection } from './rejection'

// The one plugin every bundle is, so a skill keeps its name (conclave-skills:<skill>) and the
// agent's prompt its text from one start to the next.
export const BUNDLE_PLUGIN = { name: 'conclave-skills', version: '1.0.0' } as const
// Skills are text with a few scripts; a bundle past this is not one.
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024

const Manifest = z.object({ version: z.literal(1), entries: z.array(z.object({ repo: SkillRepoId, commit: CommitSha, skill: SkillName })) })
type Entry = z.infer<typeof Manifest>['entries'][number]

export type SkillBundle = { dir: string; skills: SkillRef[]; missing: SkillRef[] }

export const reposDir = (root: string) => path.join(root, 'repos')
export const bundlesDir = (root: string) => path.join(root, 'bundles')

// Names the bundle by what goes in it: the same skills at the same pins give the same folder,
// which keeps an agent's prompt cache warm; a pin moved gives a new one. The plugin's name is in
// the key too, so a bundle of another name is never mistaken for this one.
export function bundleKey(entries: readonly Entry[]): string {
  const sorted = [...entries].sort((a, b) => a.repo.localeCompare(b.repo) || a.skill.localeCompare(b.skill))
  const pinned = JSON.stringify(sorted.map(({ repo, commit, skill }) => ({ repo, commit, skill })))
  return createHash('sha256').update(`${BUNDLE_PLUGIN.name}\n${pinned}`).digest('hex').slice(0, 16)
}

// Files and folders only: a link in a repository could point a bundle anywhere on the machine. Git's
// own folder stays out, there whenever a skill is the whole repository.
async function copyTree(from: string, to: string, budget: { left: number }): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) await copyTree(source, target, budget)
    else if (entry.isFile()) {
      budget.left -= (await stat(source)).size
      if (budget.left < 0) throw new Rejection('skills-too-large', '技能文件过大')
      await copyFile(source, target)
    }
  }
}

// The folder an agent is given for these skills: the Agent Skills layout under .agents/skills,
// which Cursor reads from a folder it is given, and the same skills as a Claude Code plugin.
// Built once per key, then reused; two starts asking at once build twice and keep one.
export async function buildBundle(root: string, repos: readonly SkillRepo[], refs: readonly SkillRef[]): Promise<SkillBundle | null> {
  const entries: Entry[] = []
  const skills: SkillRef[] = []
  const missing: SkillRef[] = []
  for (const ref of refs) {
    const repo = repos.find((each) => each.id === ref.repo)
    const skill = repo?.skills.find((each) => each.name === ref.skill && each.problem === null)
    if (!repo || !skill) { missing.push(ref); continue }
    if (entries.some((entry) => entry.skill === ref.skill)) throw new Rejection('skills-name-conflict', `两个仓库都有技能 ${ref.skill}`)
    entries.push({ repo: repo.id, commit: repo.commit, skill: skill.name })
    skills.push(ref)
  }
  if (entries.length === 0) return null
  const key = bundleKey(entries)
  const dir = path.join(bundlesDir(root), key)
  if (await manifestMatches(dir, entries)) return { dir, skills, missing }
  const tmp = path.join(bundlesDir(root), `.tmp-${randomBytes(4).toString('hex')}`)
  try {
    const budget = { left: MAX_BUNDLE_BYTES }
    for (const entry of entries) {
      const skill = repos.find((repo) => repo.id === entry.repo)?.skills.find((each) => each.name === entry.skill)
      const source = path.join(reposDir(root), entry.repo, skill?.dir ?? '')
      await copyTree(source, path.join(tmp, 'skills', entry.skill), budget)
      await copyTree(source, path.join(tmp, '.agents', 'skills', entry.skill), budget)
    }
    await mkdir(path.join(tmp, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(tmp, '.claude-plugin', 'plugin.json'), `${JSON.stringify(BUNDLE_PLUGIN, null, 2)}\n`)
    await writeFile(path.join(tmp, 'bundle.json'), `${JSON.stringify({ version: 1, entries, builtAt: Date.now() }, null, 2)}\n`)
    if (await manifestMatches(dir, entries)) await rm(tmp, { recursive: true, force: true })
    else await rename(tmp, dir)
  } catch (error) {
    await rm(tmp, { recursive: true, force: true })
    throw error
  }
  return { dir, skills, missing }
}

async function manifestMatches(dir: string, entries: readonly Entry[]): Promise<boolean> {
  try {
    const parsed = Manifest.safeParse(JSON.parse(await readFile(path.join(dir, 'bundle.json'), 'utf8')))
    return parsed.success && bundleKey(parsed.data.entries) === bundleKey(entries)
  } catch {
    return false
  }
}

// Bundles holding a repository's skills, for when the repository goes.
export async function removeBundlesOf(root: string, repoId: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(bundlesDir(root))
  } catch {
    return
  }
  for (const name of names) {
    const dir = path.join(bundlesDir(root), name)
    const manifest = await readFile(path.join(dir, 'bundle.json'), 'utf8').then((text) => Manifest.safeParse(JSON.parse(text)), () => null)
    if (manifest?.success && manifest.data.entries.some((entry) => entry.repo === repoId)) await rm(dir, { recursive: true, force: true })
  }
}
