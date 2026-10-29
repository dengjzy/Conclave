import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillRepo } from '@conclave/protocol'
import { buildBundle, bundleKey, removeBundlesOf } from './skill-bundle'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

describe('bundleKey', () => {
  it('names a bundle by its skills and their pins, in any order', () => {
    const one = bundleKey([{ repo: 'r', commit: COMMIT_A, skill: 'x' }, { repo: 'r', commit: COMMIT_A, skill: 'y' }])
    expect(one).toMatch(/^[0-9a-f]{16}$/)
    expect(bundleKey([{ repo: 'r', commit: COMMIT_A, skill: 'y' }, { repo: 'r', commit: COMMIT_A, skill: 'x' }])).toBe(one)
    expect(bundleKey([{ repo: 'r', commit: COMMIT_B, skill: 'x' }, { repo: 'r', commit: COMMIT_A, skill: 'y' }])).not.toBe(one)
  })
})

describe('buildBundle', () => {
  let root: string
  const repo = (id: string, commit: string, skills: string[]): SkillRepo => ({
    id, url: `https://example.com/${id}`, commit, previousCommit: null, installedAt: 0, updatedAt: 0, plugin: null,
    skills: skills.map((name) => ({ name, description: `Does ${name}.`, dir: `skills/${name}`, problem: name === 'broken' ? 'bad' : null }))
  })
  const place = (id: string, name: string, files: Record<string, string> = { 'SKILL.md': `---\nname: ${name}\ndescription: Does ${name}.\n---\n` }) => {
    const dir = path.join(root, 'repos', id, 'skills', name)
    mkdirSync(dir, { recursive: true })
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      writeFileSync(path.join(dir, file), text)
    }
  }

  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-bundle-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('copies the chosen skills twice over, as a plugin and as an agents folder, under one manifest', async () => {
    place('r', 'notes', { 'SKILL.md': '---\nname: notes\n---\n', 'scripts/run.sh': 'echo' })
    place('r', 'other')
    const bundle = await buildBundle(root, [repo('r', COMMIT_A, ['notes', 'other'])], [{ repo: 'r', skill: 'notes' }])
    expect(bundle).toEqual({ dir: path.join(root, 'bundles', bundleKey([{ repo: 'r', commit: COMMIT_A, skill: 'notes' }])), skills: [{ repo: 'r', skill: 'notes' }], missing: [] })
    expect(readFileSync(path.join(bundle!.dir, 'skills', 'notes', 'scripts', 'run.sh'), 'utf8')).toBe('echo')
    expect(readFileSync(path.join(bundle!.dir, '.agents', 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain('name: notes')
    expect(JSON.parse(readFileSync(path.join(bundle!.dir, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({ name: 'conclave-skills', version: '1.0.0' })
    expect(existsSync(path.join(bundle!.dir, 'skills', 'other'))).toBe(false)
    expect(readdirSync(path.join(root, 'bundles'))).toEqual([path.basename(bundle!.dir)])
  })

  it('gives the same folder again while nothing moved, and another once a pin did', async () => {
    place('r', 'notes')
    const first = await buildBundle(root, [repo('r', COMMIT_A, ['notes'])], [{ repo: 'r', skill: 'notes' }])
    writeFileSync(path.join(first!.dir, 'marker'), '')
    const again = await buildBundle(root, [repo('r', COMMIT_A, ['notes'])], [{ repo: 'r', skill: 'notes' }])
    expect(again!.dir).toBe(first!.dir)
    expect(existsSync(path.join(first!.dir, 'marker'))).toBe(true)
    const moved = await buildBundle(root, [repo('r', COMMIT_B, ['notes'])], [{ repo: 'r', skill: 'notes' }])
    expect(moved!.dir).not.toBe(first!.dir)
  })

  it('tells of skills it cannot give, and gives nothing for none', async () => {
    place('r', 'notes')
    const bundle = await buildBundle(root, [repo('r', COMMIT_A, ['notes', 'broken'])], [{ repo: 'r', skill: 'notes' }, { repo: 'r', skill: 'broken' }, { repo: 'gone', skill: 'x' }])
    expect(bundle).toMatchObject({ skills: [{ repo: 'r', skill: 'notes' }], missing: [{ repo: 'r', skill: 'broken' }, { repo: 'gone', skill: 'x' }] })
    expect(await buildBundle(root, [repo('r', COMMIT_A, ['notes'])], [{ repo: 'gone', skill: 'x' }])).toBeNull()
  })

  it('refuses two skills of one name, and leaves links behind', async () => {
    place('r', 'notes')
    place('s', 'notes')
    await expect(buildBundle(root, [repo('r', COMMIT_A, ['notes']), repo('s', COMMIT_B, ['notes'])], [{ repo: 'r', skill: 'notes' }, { repo: 's', skill: 'notes' }])).rejects.toMatchObject({ reason: 'skills-name-conflict' })
    symlinkSync(os.homedir(), path.join(root, 'repos', 'r', 'skills', 'notes', 'home'))
    const bundle = await buildBundle(root, [repo('r', COMMIT_A, ['notes'])], [{ repo: 'r', skill: 'notes' }])
    expect(existsSync(path.join(bundle!.dir, 'skills', 'notes', 'home'))).toBe(false)
  })

  it('removes the bundles a repository is in', async () => {
    place('r', 'notes')
    place('s', 'other')
    const mixed = await buildBundle(root, [repo('r', COMMIT_A, ['notes']), repo('s', COMMIT_B, ['other'])], [{ repo: 'r', skill: 'notes' }, { repo: 's', skill: 'other' }])
    const alone = await buildBundle(root, [repo('s', COMMIT_B, ['other'])], [{ repo: 's', skill: 'other' }])
    await removeBundlesOf(root, 'r')
    expect(existsSync(mixed!.dir)).toBe(false)
    expect(existsSync(alone!.dir)).toBe(true)
  })
})
