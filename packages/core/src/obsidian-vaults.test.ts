import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectKnowledgeFolder, obsidianRegistryFile, readObsidianVaults } from './obsidian-vaults'

describe('obsidianRegistryFile', () => {
  it('finds the registry where each platform keeps it', () => {
    expect(obsidianRegistryFile({ platform: 'darwin', homedir: '/Users/me', env: {} })).toBe('/Users/me/Library/Application Support/obsidian/obsidian.json')
    expect(obsidianRegistryFile({ platform: 'linux', homedir: '/home/me', env: {} })).toBe('/home/me/.config/obsidian/obsidian.json')
    expect(obsidianRegistryFile({ platform: 'linux', homedir: '/home/me', env: { XDG_CONFIG_HOME: '/xdg' } })).toBe('/xdg/obsidian/obsidian.json')
    expect(obsidianRegistryFile({ platform: 'win32', homedir: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', 'obsidian', 'obsidian.json'))
    expect(obsidianRegistryFile({ platform: 'win32', homedir: 'C:\\Users\\me', env: {} })).toBeNull()
  })
})

describe('readObsidianVaults', () => {
  let home: string
  const registry = () => path.join(home, '.config', 'obsidian', 'obsidian.json')
  const where = () => ({ platform: 'linux' as const, homedir: home, env: {} })

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'conclave-obsidian-'))
    mkdirSync(path.dirname(registry()), { recursive: true })
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists the vaults Obsidian knows, the open one first, and drops those whose folder is gone', async () => {
    const notes = path.join(home, 'notes')
    const work = path.join(home, 'work')
    mkdirSync(path.join(notes, '.obsidian'), { recursive: true })
    mkdirSync(path.join(work, '.claude', 'skills'), { recursive: true })
    writeFileSync(registry(), JSON.stringify({ vaults: {
      a: { path: notes, ts: 100 },
      b: { path: work, ts: 50, open: true },
      c: { path: path.join(home, 'gone'), ts: 200 }
    } }))
    expect(await readObsidianVaults(where())).toEqual([
      { path: work, name: 'work', open: true, skillDirs: ['.claude/skills'] },
      { path: notes, name: 'notes', open: false, skillDirs: [] }
    ])
  })

  it('offers none without a registry, or with one it cannot read', async () => {
    expect(await readObsidianVaults(where())).toEqual([])
    writeFileSync(registry(), 'not json')
    expect(await readObsidianVaults(where())).toEqual([])
    writeFileSync(registry(), '{"vaults": 3}')
    expect(await readObsidianVaults(where())).toEqual([])
  })

  it('tells a vault from a plain folder, and the skill folders agents would load', async () => {
    const vault = path.join(home, 'vault')
    mkdirSync(path.join(vault, '.obsidian'), { recursive: true })
    mkdirSync(path.join(vault, '.agents', 'skills'), { recursive: true })
    expect(await inspectKnowledgeFolder(vault)).toEqual({ vault: true, skillDirs: ['.agents/skills'] })
    expect(await inspectKnowledgeFolder(home)).toEqual({ vault: false, skillDirs: [] })
  })
})
