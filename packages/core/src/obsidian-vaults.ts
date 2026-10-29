import { access, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AGENT_SKILL_DIRS, type KnowledgeFolder, type KnowledgeVault } from '@conclave/protocol'
import { readJsonIfExists } from '@conclave/protocol/node'

// Obsidian's own list of the vaults it opened, kept beside its settings.
const Registry = z.object({
  vaults: z.record(z.string(), z.object({ path: z.string(), ts: z.number().optional(), open: z.boolean().optional() }))
})

type Where = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; homedir?: string }

export function obsidianRegistryFile({ platform = process.platform, env = process.env, homedir = os.homedir() }: Where = {}): string | null {
  switch (platform) {
    case 'darwin': return path.join(homedir, 'Library', 'Application Support', 'obsidian', 'obsidian.json')
    case 'win32': return env.APPDATA ? path.join(env.APPDATA, 'obsidian', 'obsidian.json') : null
    default: return path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'obsidian', 'obsidian.json')
  }
}

const exists = (file: string) => access(file).then(() => true, () => false)

// Which of the folders agents load skills from are in this folder, and whether it is a vault.
export async function inspectKnowledgeFolder(dir: string): Promise<KnowledgeFolder> {
  const [vault, ...found] = await Promise.all([exists(path.join(dir, '.obsidian')), ...AGENT_SKILL_DIRS.map((skills) => exists(path.join(dir, skills)))])
  return { vault, skillDirs: AGENT_SKILL_DIRS.filter((_, index) => found[index]) }
}

// The vaults Obsidian knows, the open one first and then the latest used. Never throws: a machine
// without Obsidian, or with a registry it cannot read, simply has none to offer.
export async function readObsidianVaults(where: Where = {}): Promise<KnowledgeVault[]> {
  const file = obsidianRegistryFile(where)
  if (!file) return []
  let registry: z.infer<typeof Registry>
  try {
    const parsed = Registry.safeParse(await readJsonIfExists(file))
    if (!parsed.success) return []
    registry = parsed.data
  } catch {
    return []
  }
  const entries = Object.values(registry.vaults).sort((a, b) => Number(b.open ?? false) - Number(a.open ?? false) || (b.ts ?? 0) - (a.ts ?? 0))
  const vaults = await Promise.all(entries.map(async (entry) => {
    if (!(await stat(entry.path).catch(() => null))?.isDirectory()) return null
    const { skillDirs } = await inspectKnowledgeFolder(entry.path)
    return { path: entry.path, name: path.basename(entry.path), open: entry.open ?? false, skillDirs }
  }))
  return vaults.filter((vault) => vault !== null)
}
