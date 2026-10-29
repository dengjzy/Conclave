import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { AGENT_KINDS, activatedSkillNames, agentDescriptor, skillNameConflicts, skillRepositoryUrl, SkillRepo, SkillRepoId, type AgentKind, type RecommendedSkillRepo, type SkillActivation, type SkillEntry, type SkillRef, type SkillUpdateCheck } from '@conclave/protocol'
import { readJsonIfExists, writePrivateJson } from '@conclave/protocol/node'
import { writeGit } from './git-repository'
import { gitOrNull } from './git-changes'
import { Rejection } from './rejection'
import { buildBundle, removeBundlesOf, reposDir, type SkillBundle } from './skill-bundle'
import { fileSource, readPluginManifest, scanSkills, type SkillSource } from './skill-manifest'
import { RECOMMENDED_SKILL_REPOS } from './skills-recommended'
import { skillUpdateChanges } from './skill-update'

const Lock = z.object({ version: z.literal(1), repos: z.array(SkillRepo) })
const README_LIMIT = 16 * 1024
const skillAgents = () => AGENT_KINDS.filter((agent) => agentDescriptor(agent).capabilities.skills)

// A repository's name from its URL: its owner and name, as a slug.
export function skillRepoId(url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean)
  const slug = parts.slice(-2).join('-').replace(/\.git$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return SkillRepoId.safeParse(slug).success ? slug : 'skills'
}

// Agent Skills installed from git, each pinned at a commit the user moves on purpose, and the
// bundles agents are given from them. Changes run one at a time: an update and a build at once
// could bundle half a repository.
export class SkillsLibrary {
  private repos: SkillRepo[] = []
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly changed: (repos: readonly SkillRepo[]) => void,
    // Tests install from a local repository; users only over https, which prompts for nothing.
    private readonly options: { allowFileUrls?: boolean; legacySkills?: () => readonly SkillRef[] } = {}
  ) {}

  private get lockFile(): string { return path.join(this.root, 'skills.json') }
  private repoDir(id: string): string { return path.join(reposDir(this.root), id) }

  async load(): Promise<void> {
    try {
      const raw = await readJsonIfExists(this.lockFile)
      const parsed = raw === undefined ? null : Lock.safeParse(raw)
      if (parsed && !parsed.success) console.error(`[conclave-core] ${this.lockFile} is not a skills lock; ignoring it until a skill is installed`)
      this.repos = parsed?.success ? parsed.data.repos : []
      // The lock is authoritative after a process exit between checkout and saving the pin.
      for (const repo of this.repos) {
        const dir = this.repoDir(repo.id)
        if ((await gitOrNull(dir, ['rev-parse', 'HEAD'])) !== repo.commit) {
          await writeGit(dir, ['checkout', '--detach', '--force', '--quiet', repo.commit]).catch((error: unknown) => console.error('[conclave-core] cannot restore skill pin:', repo.id, error))
        }
      }
    } catch (error) {
      console.error(`[conclave-core] cannot read ${this.lockFile}:`, error instanceof Error ? error.message : error)
      this.repos = []
    }
  }

  list(): readonly SkillRepo[] { return this.repos }
  recommended(): readonly RecommendedSkillRepo[] { return RECOMMENDED_SKILL_REPOS }

  private serially<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.catch(() => {}).then(action)
    this.chain = result
    return result
  }

  private require(id: string): SkillRepo {
    const repo = this.repos.find((each) => each.id === id)
    if (!repo) throw new Rejection('skills-unknown', '没有这个技能仓库')
    return repo
  }

  private async save(repos: SkillRepo[]): Promise<void> {
    await writePrivateJson(this.lockFile, { version: 1, repos })
    this.repos = repos
    try { this.changed(repos) } catch (error) { console.error('[conclave-core] skills notification failed:', error) }
  }

  private checkUrl(url: string): string {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Rejection('skills-invalid-url', '不是有效的地址')
    }
    const allowed = parsed.protocol === 'https:' || (this.options.allowFileUrls && parsed.protocol === 'file:')
    if (!allowed || /\s/.test(url) || url.startsWith('-')) throw new Rejection('skills-invalid-url', '只接受 https:// 地址')
    return skillRepositoryUrl(parsed.href)
  }

  // Clones at the repository's head and pins it there; a repository with no usable skill is not kept.
  install(rawUrl: string): Promise<SkillRepo> {
    return this.serially(async () => {
      const url = this.checkUrl(rawUrl)
      if (this.repos.some((repo) => skillRepositoryUrl(repo.url) === url)) throw new Rejection('skills-already-installed', '这个仓库已经安装')
      const base = skillRepoId(url)
      let id = base
      for (let n = 2; this.repos.some((repo) => repo.id === id); n++) id = `${base}-${n}`
      await mkdir(reposDir(this.root), { recursive: true, mode: 0o700 })
      const tmp = path.join(reposDir(this.root), `.tmp-${randomBytes(4).toString('hex')}`)
      try {
        await writeGit(reposDir(this.root), ['clone', '--quiet', '--no-tags', '--no-recurse-submodules', '--', url, tmp])
        const commit = await writeGit(tmp, ['rev-parse', 'HEAD'])
        await writeGit(tmp, ['checkout', '--detach', '--quiet', commit])
        const source = fileSource(tmp)
        const skills = await scanSkills(source)
        this.requireUsable(skills)
        const plugin = await readPluginManifest(source)
        await rm(this.repoDir(id), { recursive: true, force: true })
        await rename(tmp, this.repoDir(id))
        const now = Date.now()
        const repo: SkillRepo = { id, url, commit, previousCommit: null, installedAt: now, updatedAt: now, plugin, skills, activation: { mode: 'selected', skills: [], agents: null } }
        try { await this.save([...this.repos, repo]) }
        catch (error) { await rm(this.repoDir(id), { recursive: true, force: true }); throw error }
        return repo
      } catch (error) {
        await rm(tmp, { recursive: true, force: true })
        throw error
      }
    })
  }

  private requireUsable(skills: readonly SkillEntry[]): void {
    if (skills.some((skill) => skill.problem === null)) return
    const problems = skills.filter((skill) => skill.problem !== null).slice(0, 3).map((skill) => `${skill.dir}：${skill.problem}`)
    throw new Rejection('skills-none-found', problems.length > 0
      ? `仓库里没有可用的技能（${problems.join('；')}）`
      : '仓库里没有找到 SKILL.md（已扫描技能目录、根目录和各级子目录）')
  }

  private requireNoConflicts(repos: readonly SkillRepo[], id: string): void {
    const fallback = this.options.legacySkills?.() ?? []
    const effective = repos.map((repo) => repo.activation ? repo : { ...repo, activation: { mode: 'selected' as const, skills: activatedSkillNames(repo, fallback), agents: null } })
    const conflicts = skillNameConflicts(effective, skillAgents()).filter((conflict) => conflict.repos.includes(id))
    if (conflicts.length) throw new Rejection('skills-name-conflict', conflicts.slice(0, 5).map((conflict) => `${conflict.name} · ${agentDescriptor(conflict.agent).label}：${conflict.repos.join('、')}`).join('；'))
  }

  setActivation(id: string, input: SkillActivation): Promise<SkillRepo> {
    return this.serially(async () => {
      const repo = this.require(id)
      const skills = [...new Set(input.skills)]
      if (skills.some((name) => !repo.skills.some((skill) => skill.name === name && skill.problem === null))) throw new Rejection('skills-invalid-selection', '所选技能已不存在或不可用，请重新选择')
      if (input.agents?.some((agent) => !agentDescriptor(agent).capabilities.skills)) throw new Rejection('skills-invalid-selection', '所选 Agent 暂不支持技能')
      const activation: SkillActivation = { ...input, skills, agents: input.agents === null ? null : [...new Set(input.agents)] }
      const saved = { ...repo, activation }
      const repos = this.repos.map((each) => each.id === id ? saved : each)
      this.requireNoConflicts(repos, id)
      await this.save(repos)
      return saved
    })
  }

  async readme(id: string): Promise<string | null> {
    const repo = this.require(id)
    const text = await readFile(path.join(this.repoDir(repo.id), 'README.md'), 'utf8').catch(() => null)
    return text === null ? null : text.slice(0, README_LIMIT)
  }

  // What the remote's head holds now, read out of git without moving the working tree.
  checkUpdate(id: string): Promise<SkillUpdateCheck> {
    return this.serially(async () => {
      const repo = this.require(id)
      const dir = this.repoDir(repo.id)
      await writeGit(dir, ['fetch', '--quiet', '--no-tags', 'origin', 'HEAD'])
      const latest = await writeGit(dir, ['rev-parse', 'FETCH_HEAD'])
      const behind = Number(await writeGit(dir, ['rev-list', '--count', `${repo.commit}..${latest}`]))
      const skills = await scanSkills(this.commitSource(dir, latest))
      const files = (await writeGit(dir, ['diff', '--name-only', '-z', repo.commit, latest, '--'])).split('\0').filter(Boolean)
      return { id: repo.id, current: repo.commit, latest, behind, skills, changes: skillUpdateChanges(repo.skills, skills, files) }
    })
  }

  private commitSource(dir: string, commit: string): SkillSource {
    return {
      folders: async (parent) => {
        const listing = await gitOrNull(dir, ['ls-tree', '--name-only', '-d', `${commit}:${parent === '.' ? '' : parent}`])
        return listing ? listing.split('\n').map((line) => line.trim()).filter(Boolean) : []
      },
      read: (file) => gitOrNull(dir, ['show', `${commit}:${file}`])
    }
  }

  // Moves the pin to the commit the user saw; the one left is kept for a rollback.
  update(id: string, commit: string, allowUnavailable = false): Promise<SkillRepo> {
    return this.serially(() => this.moveTo(id, commit, false, allowUnavailable))
  }

  rollback(id: string): Promise<SkillRepo> {
    return this.serially(async () => {
      const repo = this.require(id)
      if (!repo.previousCommit) throw new Rejection('skills-nothing-to-rollback', '没有可回退的版本')
      // The rollback itself can be undone the same way.
      return this.moveTo(id, repo.previousCommit, true, false)
    })
  }

  private async moveTo(id: string, commit: string, rollback: boolean, allowUnavailable: boolean): Promise<SkillRepo> {
    const repo = this.require(id)
    const dir = this.repoDir(repo.id)
    await writeGit(dir, ['cat-file', '-e', `${commit}^{commit}`]).catch(() => { throw new Rejection('skills-bad-commit', '仓库里没有这个提交，请重新检查更新') })
    const source = this.commitSource(dir, commit)
    const skills = await scanSkills(source)
    this.requireUsable(skills)
    let activation = rollback && repo.previousActivation !== undefined ? repo.previousActivation ?? undefined : repo.activation
    const unavailable = activatedSkillNames(repo, this.options.legacySkills?.() ?? []).filter((name) => !skills.some((skill) => skill.name === name && skill.problem === null))
    if (!rollback && !allowUnavailable && unavailable.length) throw new Rejection('skills-update-confirmation', unavailable.join('、'))
    if (activation) activation = { ...activation, skills: activation.skills.filter((name) => skills.some((skill) => skill.name === name && skill.problem === null)) }
    const moved: SkillRepo = { ...repo, commit, previousCommit: repo.commit, previousActivation: repo.activation ?? null, activation, updatedAt: Date.now(), plugin: await readPluginManifest(source), skills }
    const repos = this.repos.map((each) => each.id === id ? moved : each)
    this.requireNoConflicts(repos, id)
    try {
      await writeGit(dir, ['checkout', '--detach', '--force', '--quiet', commit])
      await this.save(repos)
    } catch (error) {
      await writeGit(dir, ['checkout', '--detach', '--force', '--quiet', repo.commit])
      throw error
    }
    return moved
  }

  remove(id: string): Promise<void> {
    return this.serially(async () => {
      const repo = this.require(id)
      await rm(this.repoDir(repo.id), { recursive: true, force: true })
      await removeBundlesOf(this.root, repo.id)
      await this.save(this.repos.filter((each) => each.id !== id))
    })
  }

  // The folder to give an agent for these skills; null where none of them is installed.
  bundleFor(refs: readonly SkillRef[]): Promise<SkillBundle | null> {
    return this.serially(async () => {
      await mkdir(path.join(this.root, 'bundles'), { recursive: true, mode: 0o700 })
      return buildBundle(this.root, this.repos, refs)
    })
  }

  bundleForAgent(agent: AgentKind): Promise<SkillBundle | null> {
    return this.serially(async () => {
      if (!agentDescriptor(agent).capabilities.skills) return null
      const fallback = this.options.legacySkills?.() ?? []
      const selected = this.repos.flatMap((repo) => {
        if (repo.activation?.agents && !repo.activation.agents.includes(agent)) return []
        return activatedSkillNames(repo, fallback).map((skill) => ({ repo: repo.id, skill }))
      })
      // A damaged or hand-edited lock must not make every unrelated skill disappear at launch.
      const counts = new Map<string, number>()
      for (const ref of selected) counts.set(ref.skill, (counts.get(ref.skill) ?? 0) + 1)
      const refs = selected.filter((ref) => counts.get(ref.skill) === 1)
      if (refs.length !== selected.length) console.error('[conclave-core] skipped conflicting skill names for', agent)
      await mkdir(path.join(this.root, 'bundles'), { recursive: true, mode: 0o700 })
      return buildBundle(this.root, this.repos, refs)
    })
  }
}
