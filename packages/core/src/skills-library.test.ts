import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillRepo } from '@conclave/protocol'
import { SkillsLibrary, skillRepoId } from './skills-library'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

describe('skillRepoId', () => {
  it('names a repository by its owner and name', () => {
    expect(skillRepoId('https://github.com/kepano/obsidian-skills')).toBe('kepano-obsidian-skills')
    expect(skillRepoId('https://github.com/Kepano/Obsidian_Skills.git')).toBe('kepano-obsidian-skills')
    expect(skillRepoId('https://example.com/')).toBe('skills')
  })
})

describe('SkillsLibrary', () => {
  let root: string
  let upstream: string
  let changes: Array<readonly SkillRepo[]>
  let library: SkillsLibrary

  const skill = (name: string, description = `Does ${name}.`) => {
    mkdirSync(path.join(upstream, 'skills', name), { recursive: true })
    writeFileSync(path.join(upstream, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`)
  }
  const commit = (message: string) => { git(upstream, 'add', '-A'); git(upstream, 'commit', '-q', '-m', message); return git(upstream, 'rev-parse', 'HEAD') }
  const url = () => pathToFileURL(upstream).href

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-skills-lib-'))
    // Named by its last two path segments, as a GitHub URL is by its owner and name.
    upstream = path.join(root, 'root', 'upstream')
    execFileSync('git', ['init', '-q', '-b', 'main', upstream])
    git(upstream, 'config', 'user.name', 'Conclave Test')
    git(upstream, 'config', 'user.email', 'conclave@example.com')
    writeFileSync(path.join(upstream, 'README.md'), '# Skills\n')
    mkdirSync(path.join(upstream, '.claude-plugin'))
    writeFileSync(path.join(upstream, '.claude-plugin', 'plugin.json'), '{"name":"test-skills","version":"0.1.0"}')
    skill('notes')
    commit('first')
    changes = []
    library = new SkillsLibrary(path.join(root, 'home', 'skills'), (repos) => changes.push(repos), { allowFileUrls: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('installs a repository pinned at its head, reads its skills, and keeps that across a reload', async () => {
    const first = git(upstream, 'rev-parse', 'HEAD')
    const repo = await library.install(url())
    expect(repo).toMatchObject({ id: 'root-upstream', url: url(), commit: first, previousCommit: null, plugin: { name: 'test-skills', version: '0.1.0' }, skills: [{ name: 'notes', description: 'Does notes.', dir: 'skills/notes', problem: null }] })
    expect(git(path.join(root, 'home', 'skills', 'repos', 'root-upstream'), 'rev-parse', 'HEAD')).toBe(first)
    expect(git(path.join(root, 'home', 'skills', 'repos', 'root-upstream'), 'branch', '--show-current')).toBe('')
    expect(changes).toEqual([[repo]])
    expect(await library.readme('root-upstream')).toBe('# Skills\n')
    const reopened = new SkillsLibrary(path.join(root, 'home', 'skills'), () => {})
    await reopened.load()
    expect(reopened.list()).toEqual([repo])
    await expect(library.install(url())).rejects.toMatchObject({ reason: 'skills-already-installed' })
  })

  it('refuses what is not an https repository, or holds no skill', async () => {
    const plain = new SkillsLibrary(path.join(root, 'home', 'skills'), () => {})
    await expect(plain.install(url())).rejects.toMatchObject({ reason: 'skills-invalid-url' })
    await expect(plain.install('http://example.com/a/b')).rejects.toMatchObject({ reason: 'skills-invalid-url' })
    await expect(plain.install('-oProxyCommand=x')).rejects.toMatchObject({ reason: 'skills-invalid-url' })
    const bare = path.join(root, 'bare')
    execFileSync('git', ['init', '-q', '-b', 'main', bare])
    git(bare, 'config', 'user.name', 'T'); git(bare, 'config', 'user.email', 't@example.com')
    writeFileSync(path.join(bare, 'README.md'), '')
    git(bare, 'add', '-A'); git(bare, 'commit', '-q', '-m', 'empty')
    await expect(library.install(pathToFileURL(bare).href)).rejects.toMatchObject({ reason: 'skills-none-found' })
    expect(existsSync(path.join(root, 'home', 'skills', 'repos'))).toBe(true)
    expect(library.list()).toEqual([])
  })

  it('tells what an update brings before moving the pin, moves it, and rolls back', async () => {
    const first = (await library.install(url())).commit
    skill('canvas')
    const second = commit('add canvas')
    const check = await library.checkUpdate('root-upstream')
    expect(check).toMatchObject({ id: 'root-upstream', current: first, latest: second, behind: 1 })
    expect(check.skills.map((entry) => entry.name)).toEqual(['canvas', 'notes'])
    expect(library.list()[0]?.commit).toBe(first)

    const updated = await library.update('root-upstream', second)
    expect(updated).toMatchObject({ commit: second, previousCommit: first })
    expect(updated.skills.map((entry) => entry.name)).toEqual(['canvas', 'notes'])
    expect(git(path.join(root, 'home', 'skills', 'repos', 'root-upstream'), 'rev-parse', 'HEAD')).toBe(second)
    await expect(library.update('root-upstream', 'f'.repeat(40))).rejects.toMatchObject({ reason: 'skills-bad-commit' })

    const back = await library.rollback('root-upstream')
    expect(back).toMatchObject({ commit: first, previousCommit: second })
    expect(back.skills.map((entry) => entry.name)).toEqual(['notes'])
    await expect(new SkillsLibrary(root, () => {}).rollback('nope')).rejects.toMatchObject({ reason: 'skills-unknown' })
  })

  it('bundles the installed skills asked for, and removes a repository with its bundles', async () => {
    await library.install(url())
    expect(await library.bundleFor([{ repo: 'root-upstream', skill: 'canvas' }])).toBeNull()
    const bundle = await library.bundleFor([{ repo: 'root-upstream', skill: 'notes' }, { repo: 'root-upstream', skill: 'canvas' }])
    expect(bundle).toMatchObject({ skills: [{ repo: 'root-upstream', skill: 'notes' }], missing: [{ repo: 'root-upstream', skill: 'canvas' }] })
    expect(readFileSync(path.join(bundle!.dir, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain('name: notes')
    await library.remove('root-upstream')
    expect(library.list()).toEqual([])
    expect(existsSync(bundle!.dir)).toBe(false)
    expect(existsSync(path.join(root, 'home', 'skills', 'repos', 'root-upstream'))).toBe(false)
    expect(JSON.parse(readFileSync(path.join(root, 'home', 'skills', 'skills.json'), 'utf8'))).toEqual({ version: 1, repos: [] })
  })

  it('installs nested skills with their files, previews a changed layout, updates and rolls back', async () => {
    rmSync(path.join(upstream, 'skills'), { recursive: true })
    const dir = path.join(upstream, 'skills', 'engineering', 'tdd')
    mkdirSync(path.join(dir, 'references'), { recursive: true })
    writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: tdd\ndescription: Test-driven development.\n---\n')
    writeFileSync(path.join(dir, 'references', 'tests.md'), 'Write a failing test first.')
    const first = commit('nested skills')
    const repo = await library.install(url())
    expect(repo.skills).toEqual([{ name: 'tdd', description: 'Test-driven development.', dir: 'skills/engineering/tdd', problem: null }])
    const bundle = await library.bundleFor([{ repo: repo.id, skill: 'tdd' }])
    for (const layout of ['skills', '.agents/skills']) {
      expect(readFileSync(path.join(bundle?.dir ?? '', layout, 'tdd', 'references', 'tests.md'), 'utf8')).toBe('Write a failing test first.')
    }

    const moved = path.join(upstream, 'plugins', 'testing', 'skills', 'tdd')
    rmSync(path.join(upstream, 'skills'), { recursive: true })
    mkdirSync(moved, { recursive: true })
    writeFileSync(path.join(moved, 'SKILL.md'), '---\nname: tdd\ndescription: Updated testing.\n---\n')
    const second = commit('move skill into a plugin')
    const check = await library.checkUpdate(repo.id)
    expect(check.skills).toEqual([{ name: 'tdd', description: 'Updated testing.', dir: 'plugins/testing/skills/tdd', problem: null }])
    expect(library.list()[0]?.commit).toBe(first)
    expect(existsSync(path.join(root, 'home', 'skills', 'repos', repo.id, 'skills', 'engineering', 'tdd', 'SKILL.md'))).toBe(true)
    expect((await library.update(repo.id, second)).skills).toEqual(check.skills)
    const updatedBundle = await library.bundleFor([{ repo: repo.id, skill: 'tdd' }])
    expect(readFileSync(path.join(updatedBundle?.dir ?? '', 'skills', 'tdd', 'SKILL.md'), 'utf8')).toContain('Updated testing.')
    expect((await library.rollback(repo.id)).skills).toEqual(repo.skills)
  })

  it('reports malformed skill metadata instead of claiming the layout is unsupported', async () => {
    rmSync(path.join(upstream, 'skills'), { recursive: true })
    const dir = path.join(upstream, 'skills', 'engineering', 'tdd')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: tdd\n---\n')
    commit('missing description')
    await expect(library.install(url())).rejects.toMatchObject({ reason: 'skills-none-found', message: '仓库里没有可用的技能（skills/engineering/tdd：缺少 description）' })
    expect(library.list()).toEqual([])
  })

  it('starts with no selected skills, loads them for the chosen agents and persists activation', async () => {
    const repo = await library.install(url())
    expect(await library.bundleForAgent('claude')).toBeNull()
    await library.setActivation(repo.id, { mode: 'selected', skills: ['notes'], agents: ['claude'] })
    expect((await library.bundleForAgent('claude'))?.skills).toEqual([{ repo: repo.id, skill: 'notes' }])
    expect(await library.bundleForAgent('pi')).toBeNull()
    await library.setActivation(repo.id, { mode: 'all', skills: ['notes'], agents: null })
    expect((await library.bundleForAgent('pi'))?.skills).toEqual([{ repo: repo.id, skill: 'notes' }])
    expect(await library.bundleForAgent('codex')).toBeNull()
    const reopened = new SkillsLibrary(path.join(root, 'home', 'skills'), () => {})
    await reopened.load()
    expect(reopened.list()[0]?.activation).toEqual({ mode: 'all', skills: ['notes'], agents: null })
    await expect(library.setActivation(repo.id, { mode: 'selected', skills: ['missing'], agents: null })).rejects.toMatchObject({ reason: 'skills-invalid-selection' })
    await expect(library.setActivation(repo.id, { mode: 'all', skills: [], agents: ['codex'] })).rejects.toMatchObject({ reason: 'skills-invalid-selection' })
  })

  it('keeps additions off in selected mode and includes them after an update in all mode', async () => {
    const repo = await library.install(url())
    await library.setActivation(repo.id, { mode: 'selected', skills: ['notes'], agents: null })
    skill('canvas')
    const next = commit('more skills')
    await library.checkUpdate(repo.id)
    await library.update(repo.id, next)
    expect((await library.bundleForAgent('claude'))?.skills).toEqual([{ repo: repo.id, skill: 'notes' }])
    await library.setActivation(repo.id, { mode: 'all', skills: ['notes'], agents: null })
    expect((await library.bundleForAgent('claude'))?.skills).toEqual([{ repo: repo.id, skill: 'canvas' }, { repo: repo.id, skill: 'notes' }])
    skill('research')
    const latest = commit('add research')
    await library.checkUpdate(repo.id)
    await library.update(repo.id, latest)
    expect((await library.bundleForAgent('claude'))?.skills).toEqual([{ repo: repo.id, skill: 'canvas' }, { repo: repo.id, skill: 'notes' }, { repo: repo.id, skill: 'research' }])
  })

  it('requires acknowledgment for losing enabled skills and restores selection on rollback', async () => {
    const repo = await library.install(url())
    await library.setActivation(repo.id, { mode: 'selected', skills: ['notes'], agents: null })
    rmSync(path.join(upstream, 'skills', 'notes'), { recursive: true })
    skill('canvas')
    const next = commit('replace notes')
    const check = await library.checkUpdate(repo.id)
    expect(check.changes).toEqual([{ name: 'canvas', kind: 'added' }, { name: 'notes', kind: 'removed' }])
    await expect(library.update(repo.id, next)).rejects.toMatchObject({ reason: 'skills-update-confirmation' })
    expect(library.list()[0]?.commit).toBe(repo.commit)
    await library.update(repo.id, next, true)
    expect(library.list()[0]?.activation?.skills).toEqual([])
    expect((await library.rollback(repo.id)).activation?.skills).toEqual(['notes'])
  })

  it('rejects unusable update commits without changing the pin or lock', async () => {
    const repo = await library.install(url())
    writeFileSync(path.join(upstream, 'skills', 'notes', 'SKILL.md'), '# broken')
    const next = commit('break manifest')
    await library.checkUpdate(repo.id)
    await expect(library.update(repo.id, next, true)).rejects.toMatchObject({ reason: 'skills-none-found' })
    expect(git(path.join(root, 'home', 'skills', 'repos', repo.id), 'rev-parse', 'HEAD')).toBe(repo.commit)
    expect(library.list()[0]?.commit).toBe(repo.commit)
  })

  it('restores checkout after a lock write failure and recovers a crash from the saved pin', async () => {
    const repo = await library.install(url())
    skill('canvas')
    const next = commit('new version')
    await library.checkUpdate(repo.id)
    const lock = path.join(root, 'home', 'skills', 'skills.json')
    renameSync(lock, `${lock}.saved`)
    mkdirSync(lock)
    await expect(library.update(repo.id, next)).rejects.toThrow()
    const dir = path.join(root, 'home', 'skills', 'repos', repo.id)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(repo.commit)
    expect(library.list()[0]?.commit).toBe(repo.commit)
    rmSync(lock, { recursive: true })
    renameSync(`${lock}.saved`, lock)
    git(dir, 'checkout', '--detach', '--quiet', next)
    const reopened = new SkillsLibrary(path.join(root, 'home', 'skills'), () => {})
    await reopened.load()
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(repo.commit)
  })

  it('rejects activation and updates with overlapping names, while allowing disjoint agent scopes', async () => {
    const a = await library.install(url())
    await library.setActivation(a.id, { mode: 'all', skills: [], agents: ['claude'] })
    const other = path.join(root, 'other')
    execFileSync('git', ['clone', '-q', upstream, other])
    const b = await library.install(pathToFileURL(other).href)
    await expect(library.setActivation(b.id, { mode: 'all', skills: [], agents: null })).rejects.toMatchObject({ reason: 'skills-name-conflict' })
    await library.setActivation(b.id, { mode: 'all', skills: [], agents: ['pi'] })
    expect((await library.bundleForAgent('claude'))?.skills).toEqual([{ repo: a.id, skill: 'notes' }])
    expect((await library.bundleForAgent('pi'))?.skills).toEqual([{ repo: b.id, skill: 'notes' }])
  })

  it('rejects an all-mode update that introduces a conflicting skill before moving files', async () => {
    const a = await library.install(url())
    await library.setActivation(a.id, { mode: 'all', skills: [], agents: null })
    const other = path.join(root, 'other')
    execFileSync('git', ['clone', '-q', upstream, other])
    rmSync(path.join(other, 'skills'), { recursive: true })
    mkdirSync(path.join(other, 'skills', 'canvas'), { recursive: true })
    writeFileSync(path.join(other, 'skills', 'canvas', 'SKILL.md'), '---\nname: canvas\ndescription: Canvas.\n---\n')
    git(other, 'add', '-A')
    git(other, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'canvas only')
    const b = await library.install(pathToFileURL(other).href)
    await library.setActivation(b.id, { mode: 'all', skills: [], agents: null })
    skill('canvas')
    const next = commit('add colliding canvas')
    await library.checkUpdate(a.id)
    await expect(library.update(a.id, next)).rejects.toMatchObject({ reason: 'skills-name-conflict' })
    expect(git(path.join(root, 'home', 'skills', 'repos', a.id), 'rev-parse', 'HEAD')).toBe(a.commit)
  })

  it('deduplicates a legacy GitHub address before attempting another clone', async () => {
    const repo = await library.install(url())
    const lock = path.join(root, 'home', 'skills', 'skills.json')
    writeFileSync(lock, JSON.stringify({ version: 1, repos: [{ ...repo, url: 'https://github.com/Team/Skills.git/' }] }))
    await library.load()
    await expect(library.install('https://github.com/team/skills')).rejects.toMatchObject({ reason: 'skills-already-installed' })
    expect(library.list()).toHaveLength(1)
  })

  it('preserves a legacy feature selection until the user explicitly disables it', async () => {
    const repo = await library.install(url())
    const { activation: _activation, ...legacy } = repo
    writeFileSync(path.join(root, 'home', 'skills', 'skills.json'), JSON.stringify({ version: 1, repos: [legacy] }))
    const fallback = [{ repo: repo.id, skill: 'notes' }]
    const reopened = new SkillsLibrary(path.join(root, 'home', 'skills'), () => {}, { legacySkills: () => fallback })
    await reopened.load()
    expect((await reopened.bundleForAgent('claude'))?.skills).toEqual(fallback)
    await reopened.setActivation(repo.id, { mode: 'selected', skills: [], agents: null })
    expect(await reopened.bundleForAgent('claude')).toBeNull()
  })

  // As s1dashu/ip-as-logo-skill publishes one: the repository is the skill, named apart from it.
  it('installs a repository that is one skill, and bundles it without its git folder', async () => {
    rmSync(path.join(upstream, 'skills'), { recursive: true })
    writeFileSync(path.join(upstream, 'SKILL.md'), '---\nname: ip-as-logo\ndescription: Draws a logo.\n---\n')
    mkdirSync(path.join(upstream, 'assets'))
    writeFileSync(path.join(upstream, 'assets', 'sample.txt'), 'sample')
    commit('one skill')
    const repo = await library.install(url())
    expect(repo.skills).toEqual([{ name: 'ip-as-logo', description: 'Draws a logo.', dir: '.', problem: null }])
    const bundle = await library.bundleFor([{ repo: repo.id, skill: 'ip-as-logo' }])
    const skillDir = path.join(bundle?.dir ?? '', 'skills', 'ip-as-logo')
    expect(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('name: ip-as-logo')
    expect(readFileSync(path.join(skillDir, 'assets', 'sample.txt'), 'utf8')).toBe('sample')
    expect(existsSync(path.join(skillDir, '.git'))).toBe(false)
    writeFileSync(path.join(upstream, 'SKILL.md'), '---\nname: ip-as-logo\ndescription: Draws a smaller logo.\n---\n')
    commit('shorter')
    expect((await library.checkUpdate(repo.id)).skills).toEqual([{ name: 'ip-as-logo', description: 'Draws a smaller logo.', dir: '.', problem: null }])
  })
})
