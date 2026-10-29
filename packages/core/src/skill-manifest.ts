import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { SkillName, type SkillEntry } from '@conclave/protocol'

const SKILL_ROOTS = ['skills', '.agents/skills', '.claude/skills', '.codex/skills']
const MAX_DESCRIPTION = 1024

// A repository's files as one commit holds them: on disk at the pinned commit, or out of git for
// a commit not checked out.
export type SkillSource = {
  // Names of the folders in a folder (relative to the repository root); [] where it is not one.
  folders(dir: string): Promise<string[]>
  // A file's text, null where there is none.
  read(file: string): Promise<string | null>
}

export function fileSource(repoDir: string): SkillSource {
  return {
    folders: async (dir) => {
      try {
        return (await readdir(path.join(repoDir, dir), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      } catch {
        return []
      }
    },
    read: (file) => readFile(path.join(repoDir, file), 'utf8').catch(() => null)
  }
}

// The scalars of SKILL.md's frontmatter: `key: value`, quoted or bare, or a `|` / `>` block.
// Enough for name and description; a list or a nested map is left out. No YAML library is needed
// for that, and a stranger file surfaces as a problem rather than a parse error.
export function parseSkillFrontmatter(text: string): Record<string, string> | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return null
  const fields: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(lines[i] ?? '')
    if (!match) continue
    const key = match[1] ?? ''
    const value = (match[2] ?? '').trim()
    const block = /^([|>])[+-]?$/.exec(value)
    if (block) {
      const kept: string[] = []
      while (i + 1 < end && (/^\s/.test(lines[i + 1] ?? '') || (lines[i + 1] ?? '').trim() === '')) kept.push((lines[++i] ?? '').trim())
      fields[key] = (block[1] === '|' ? kept.join('\n') : kept.join(' ')).trim()
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      fields[key] = value.slice(1, -1)
    } else {
      fields[key] = value
    }
  }
  return fields
}

// What a SKILL.md makes of the folder it is in; a fault is told, not thrown.
export function skillEntry(folder: string, dir: string, text: string | null): SkillEntry {
  const fields = text === null ? null : parseSkillFrontmatter(text)
  const name = fields?.name ?? folder
  const entry = { name: SkillName.safeParse(folder).success ? folder : folder.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill', description: fields?.description ?? '', dir }
  if (text === null) return { ...entry, problem: '缺少 SKILL.md' }
  if (!fields) return { ...entry, problem: 'SKILL.md 没有 frontmatter' }
  if (!SkillName.safeParse(folder).success) return { ...entry, problem: '目录名只能用小写字母、数字和连字符' }
  if (name !== folder) return { ...entry, problem: `name 是 ${name}，与目录名不一致` }
  if (!entry.description) return { ...entry, problem: '缺少 description' }
  if (entry.description.length > MAX_DESCRIPTION) return { ...entry, problem: `description 超过 ${MAX_DESCRIPTION} 字符` }
  return { ...entry, problem: null }
}

// A repository that is one skill: its folder is named after the repository, not the skill, so the
// name comes from the frontmatter alone.
export function rootSkillEntry(text: string): SkillEntry {
  const fields = parseSkillFrontmatter(text)
  const name = fields?.name ?? ''
  const valid = SkillName.safeParse(name).success
  const entry = { name: valid ? name : name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill', description: fields?.description ?? '', dir: '.' }
  if (!fields) return { ...entry, problem: 'SKILL.md 没有 frontmatter' }
  if (!name) return { ...entry, problem: '缺少 name' }
  if (!valid) return { ...entry, problem: 'name 只能用小写字母、数字和连字符' }
  if (!entry.description) return { ...entry, problem: '缺少 description' }
  if (entry.description.length > MAX_DESCRIPTION) return { ...entry, problem: `description 超过 ${MAX_DESCRIPTION} 字符` }
  return { ...entry, problem: null }
}

// Stop at a skill's boundary: its examples and references belong to it, not to the catalog.
async function skillsUnder(source: SkillSource, parent: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  const folders = (await source.folders(parent)).filter((folder) => !folder.startsWith('.') && folder !== 'node_modules' && folder !== 'vendor').sort()
  for (const folder of folders) {
    const dir = parent === '.' ? folder : `${parent}/${folder}`
    const text = await source.read(`${dir}/SKILL.md`)
    if (text !== null) entries.push(skillEntry(folder, dir, text))
    else entries.push(...await skillsUnder(source, dir))
  }
  return entries
}

// Resolve collection roots through directory listings too, so hidden roots cannot follow links.
async function hasFolder(source: SkillSource, dir: string): Promise<boolean> {
  const slash = dir.lastIndexOf('/')
  const parent = slash < 0 ? '.' : dir.slice(0, slash)
  return (parent === '.' || await hasFolder(source, parent)) && (await source.folders(parent)).includes(dir.slice(slash + 1))
}

// Prefer a conventional skill collection over a root overview or other repository files.
export async function scanSkills(source: SkillSource): Promise<SkillEntry[]> {
  let entries: SkillEntry[] = []
  for (const parent of SKILL_ROOTS) {
    if (!await hasFolder(source, parent)) continue
    entries = await skillsUnder(source, parent)
    if (entries.length > 0) break
  }
  if (entries.length === 0) {
    const root = await source.read('SKILL.md')
    if (root !== null) return [rootSkillEntry(root)]
    entries = await skillsUnder(source, '.')
  }
  const pathsByName = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.problem !== null) continue
    const paths = pathsByName.get(entry.name) ?? []
    paths.push(entry.dir)
    pathsByName.set(entry.name, paths)
  }
  return entries.map((entry) => {
    const paths = pathsByName.get(entry.name) ?? []
    return entry.problem === null && paths.length > 1 ? { ...entry, problem: `技能名重复：${paths.join('、')}` } : entry
  }).sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir))
}

// What a plugin manifest names the repository, where it has one.
export async function readPluginManifest(source: SkillSource): Promise<{ name: string; version: string } | null> {
  const text = await source.read('.claude-plugin/plugin.json')
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { name, version } = parsed as Record<string, unknown>
    return typeof name === 'string' && name ? { name, version: typeof version === 'string' ? version : '' } : null
  } catch {
    return null
  }
}
