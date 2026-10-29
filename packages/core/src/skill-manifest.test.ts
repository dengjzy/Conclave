import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileSource, parseSkillFrontmatter, readPluginManifest, rootSkillEntry, scanSkills, skillEntry } from './skill-manifest'

describe('parseSkillFrontmatter', () => {
  it('reads bare, quoted and block scalars, and leaves the rest', () => {
    const text = ['---', 'name: notes', "description: 'Write: notes'", 'version: "1.0"', 'long: >', '  one', '  two', 'kept: |', '  a', '', '  b', 'tags:', '  - x', '---', '# Body'].join('\n')
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'notes', description: 'Write: notes', version: '1.0', long: 'one two', kept: 'a\n\nb', tags: '' })
  })

  it('wants a fence at the top, closed', () => {
    expect(parseSkillFrontmatter('# Just markdown')).toBeNull()
    expect(parseSkillFrontmatter('---\nname: x\n')).toBeNull()
    expect(parseSkillFrontmatter('﻿---\r\nname: x\r\n---\r\n')).toEqual({ name: 'x' })
  })
})

describe('skillEntry', () => {
  const valid = '---\nname: notes\ndescription: Takes notes.\n---\n'
  it('accepts a skill whose name is its folder, and tells what is wrong with another', () => {
    expect(skillEntry('notes', 'skills/notes', valid)).toEqual({ name: 'notes', description: 'Takes notes.', dir: 'skills/notes', problem: null })
    expect(skillEntry('notes', 'skills/notes', null).problem).toBe('缺少 SKILL.md')
    expect(skillEntry('notes', 'skills/notes', '# no frontmatter').problem).toBe('SKILL.md 没有 frontmatter')
    expect(skillEntry('other', 'skills/other', valid).problem).toBe('name 是 notes，与目录名不一致')
    expect(skillEntry('notes', 'skills/notes', '---\nname: notes\n---\n').problem).toBe('缺少 description')
    expect(skillEntry('notes', 'skills/notes', `---\nname: notes\ndescription: ${'x'.repeat(1025)}\n---\n`).problem).toMatch(/超过/)
    expect(skillEntry('My Skill', 'skills/My Skill', valid)).toMatchObject({ name: 'my-skill', problem: '目录名只能用小写字母、数字和连字符' })
  })
})

describe('rootSkillEntry', () => {
  it('names a repository-wide skill by its frontmatter, and tells what is wrong with it', () => {
    expect(rootSkillEntry('---\nname: ip-as-logo\ndescription: Draws.\n---\n')).toEqual({ name: 'ip-as-logo', description: 'Draws.', dir: '.', problem: null })
    expect(rootSkillEntry('# no frontmatter').problem).toBe('SKILL.md 没有 frontmatter')
    expect(rootSkillEntry('---\ndescription: Draws.\n---\n')).toMatchObject({ name: 'skill', problem: '缺少 name' })
    expect(rootSkillEntry('---\nname: IP Logo\ndescription: Draws.\n---\n')).toMatchObject({ name: 'ip-logo', problem: 'name 只能用小写字母、数字和连字符' })
    expect(rootSkillEntry('---\nname: logo\n---\n').problem).toBe('缺少 description')
  })
})

describe('scanSkills', () => {
  let repo: string
  beforeEach(() => { repo = mkdtempSync(path.join(os.tmpdir(), 'conclave-skills-')) })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  const skill = (dir: string, name: string, body = `---\nname: ${name}\ndescription: Does ${name}.\n---\n`) => {
    mkdirSync(path.join(repo, dir, name), { recursive: true })
    writeFileSync(path.join(repo, dir, name, 'SKILL.md'), body)
  }

  it('lists skills/*/SKILL.md in name order, with faulty skills told and plain folders ignored', async () => {
    skill('skills', 'zeta')
    skill('skills', 'alpha')
    skill('skills', 'broken', 'nothing')
    mkdirSync(path.join(repo, 'skills', 'empty'))
    expect((await scanSkills(fileSource(repo))).map((entry) => [entry.name, entry.dir, entry.problem])).toEqual([
      ['alpha', 'skills/alpha', null], ['broken', 'skills/broken', 'SKILL.md 没有 frontmatter'], ['zeta', 'skills/zeta', null]
    ])
  })

  it('falls back to top-level folders holding a SKILL.md, skipping hidden ones and plain folders', async () => {
    skill('.', 'notes')
    mkdirSync(path.join(repo, 'docs'))
    mkdirSync(path.join(repo, '.git'))
    expect(await scanSkills(fileSource(repo))).toEqual([{ name: 'notes', description: 'Does notes.', dir: 'notes', problem: null }])
  })

  it('takes a SKILL.md at the root as the one skill the repository is, its subfolders as its files', async () => {
    writeFileSync(path.join(repo, 'SKILL.md'), '---\nname: ip-as-logo\ndescription: Draws a logo.\n---\n')
    mkdirSync(path.join(repo, 'assets'))
    expect(await scanSkills(fileSource(repo))).toEqual([{ name: 'ip-as-logo', description: 'Draws a logo.', dir: '.', problem: null }])
  })

  it('takes skills/ over a SKILL.md at the root, which then only tells of the repository', async () => {
    writeFileSync(path.join(repo, 'SKILL.md'), '---\nname: overview\ndescription: All of them.\n---\n')
    skill('skills', 'notes')
    expect((await scanSkills(fileSource(repo))).map((entry) => entry.name)).toEqual(['notes'])
  })

  it('finds skills in nested categories, as mattpocock/skills publishes them', async () => {
    skill('skills/engineering', 'tdd')
    skill('skills/productivity', 'grill-me')
    skill('skills', 'notes')
    mkdirSync(path.join(repo, 'skills', 'engineering', 'assets'))
    expect(await scanSkills(fileSource(repo))).toEqual([
      { name: 'grill-me', description: 'Does grill-me.', dir: 'skills/productivity/grill-me', problem: null },
      { name: 'notes', description: 'Does notes.', dir: 'skills/notes', problem: null },
      { name: 'tdd', description: 'Does tdd.', dir: 'skills/engineering/tdd', problem: null }
    ])
  })

  it.each(['.agents/skills', '.claude/skills', '.codex/skills'])('finds skills under %s', async (parent) => {
    skill(`${parent}/engineering`, 'notes')
    expect(await scanSkills(fileSource(repo))).toEqual([
      { name: 'notes', description: 'Does notes.', dir: `${parent}/engineering/notes`, problem: null }
    ])
  })

  it('prefers skills/ to hidden copies and ignores empty conventional directories', async () => {
    skill('skills', 'notes')
    skill('.agents/skills', 'notes')
    expect((await scanSkills(fileSource(repo))).map((entry) => entry.dir)).toEqual(['skills/notes'])
    rmSync(path.join(repo, 'skills', 'notes'), { recursive: true })
    expect((await scanSkills(fileSource(repo))).map((entry) => entry.dir)).toEqual(['.agents/skills/notes'])
    rmSync(path.join(repo, '.agents'), { recursive: true })
    skill('plugins/engineering/skills', 'notes')
    expect((await scanSkills(fileSource(repo))).map((entry) => entry.dir)).toEqual(['plugins/engineering/skills/notes'])
  })

  it('stops at a skill boundary and skips hidden folders, dependencies and directory links', async () => {
    skill('skills', 'notes')
    skill('skills/notes/examples', 'example')
    skill('skills/.hidden', 'hidden')
    skill('skills/node_modules', 'dependency')
    skill('skills/vendor', 'vendored')
    symlinkSync(path.join(repo, 'skills'), path.join(repo, 'skills', 'loop'), 'junction')
    expect((await scanSkills(fileSource(repo))).map((entry) => entry.name)).toEqual(['notes'])
  })

  it('marks duplicate names as unusable rather than silently choosing a category', async () => {
    skill('skills/engineering', 'notes')
    skill('skills/productivity', 'notes')
    const entries = await scanSkills(fileSource(repo))
    expect(entries.map((entry) => entry.dir)).toEqual(['skills/engineering/notes', 'skills/productivity/notes'])
    expect(entries.map((entry) => entry.problem)).toEqual([
      '技能名重复：skills/engineering/notes、skills/productivity/notes',
      '技能名重复：skills/engineering/notes、skills/productivity/notes'
    ])
  })

  it('does not enter a collection root or its hidden parent through a directory link', async () => {
    skill('node_modules/payload', 'hidden')
    skill('node_modules/payload/skills', 'also-hidden')
    symlinkSync(path.join(repo, 'node_modules', 'payload'), path.join(repo, 'skills'), 'junction')
    symlinkSync(path.join(repo, 'node_modules', 'payload'), path.join(repo, '.agents'), 'junction')
    expect(await scanSkills(fileSource(repo))).toEqual([])
  })

  it('reads the plugin manifest where there is one', async () => {
    expect(await readPluginManifest(fileSource(repo))).toBeNull()
    mkdirSync(path.join(repo, '.claude-plugin'))
    writeFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), '{"name":"obsidian","version":"1.2.0"}')
    expect(await readPluginManifest(fileSource(repo))).toEqual({ name: 'obsidian', version: '1.2.0' })
    writeFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'not json')
    expect(await readPluginManifest(fileSource(repo))).toBeNull()
  })
})
