import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { PROJECT_CONFIG_FILE, ProjectConfig, projectRunsCommands, tidyProjectConfig, type ProjectConfigInfo } from '@conclave/protocol'
import { readJsonIfExists, writePrivateJson } from '@conclave/protocol/node'
import { Rejection } from './rejection'
import { gitTopLevel } from './workspace'

const MAX_CONFIG_BYTES = 64 * 1024

const Trusted = z.object({ version: z.literal(1), repos: z.record(z.string(), z.string()) }).catch({ version: 1, repos: {} })

export type ProjectSetup = { topLevel: string; config: ProjectConfig; hash: string }
// A trusted config with the path it was asked for, which may be a folder inside the repo.
export type TrustedSetup = ProjectSetup & { repoPath: string }

// What the user trusts is the commands, so a change to them asks again; copy runs nothing.
export function projectConfigHash(config: ProjectConfig): string {
  return createHash('sha256').update(JSON.stringify({ setup: config.setup ?? null, check: config.check ?? null })).digest('hex')
}

// Reads `.conclave/project.json` from the project's checkout. A missing file is no config; a broken
// one refuses, since running a start without the setup it asks for would go unnoticed.
export async function readProjectConfig(repoPath: string): Promise<ProjectSetup | null> {
  const topLevel = await gitTopLevel(repoPath)
  if (!topLevel) return null
  const file = path.join(topLevel, '.conclave', PROJECT_CONFIG_FILE)
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return null
  if (info.size > MAX_CONFIG_BYTES) throw new Rejection('project-config-invalid', `${file} 超过 64KB`)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Rejection('project-config-invalid', `${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = ProjectConfig.safeParse(raw)
  if (!parsed.success) throw new Rejection('project-config-invalid', `${file}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`)
  return { topLevel, config: parsed.data, hash: projectConfigHash(parsed.data) }
}

// The hashes of the project commands the user allowed, by repo top level.
export class ProjectConfigStore {
  constructor(private readonly file: string) {}

  async info(repoPath: string): Promise<ProjectConfigInfo | null> {
    const setup = await readProjectConfig(repoPath)
    if (!setup) return null
    return { path: setup.topLevel, config: setup.config, hash: setup.hash, trusted: await this.trusts(setup) }
  }

  // Each project's config, refused with the first whose commands the user has not allowed as they
  // stand; the message is its top level, for the client to ask about.
  async requireTrusted(repoPaths: readonly string[]): Promise<TrustedSetup[]> {
    const setups: TrustedSetup[] = []
    for (const repoPath of repoPaths) {
      const setup = await readProjectConfig(repoPath)
      if (!setup) continue
      if (!(await this.trusts(setup))) throw new Rejection('project-config-untrusted', setup.topLevel)
      setups.push({ ...setup, repoPath })
    }
    return setups
  }

  async trust(repoPath: string, hash: string): Promise<void> {
    const setup = await readProjectConfig(repoPath)
    if (!setup || setup.hash !== hash) throw new Rejection('project-config-changed', '项目配置已经变了，请重新确认')
    await this.remember(setup.topLevel, hash)
  }

  // Writes the config the user filled in, over whatever the file held, broken or not: these are
  // the user's own commands, so they are allowed as written. Nothing left in it removes the file.
  async write(repoPath: string, config: ProjectConfig): Promise<ProjectConfigInfo | null> {
    const topLevel = await gitTopLevel(repoPath)
    if (!topLevel) throw new Rejection('worktree-not-git', `${repoPath} 不是 Git 仓库，用不到项目配置`)
    const file = path.join(topLevel, '.conclave', PROJECT_CONFIG_FILE)
    const tidy = tidyProjectConfig(config)
    if (Object.keys(tidy).length === 0) {
      await rm(file, { force: true })
      return null
    }
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(tidy, null, 2)}\n`)
    if (projectRunsCommands(tidy)) await this.remember(topLevel, projectConfigHash(tidy))
    return this.info(repoPath)
  }

  private async remember(topLevel: string, hash: string): Promise<void> {
    const saved = Trusted.parse(await readJsonIfExists(this.file))
    await writePrivateJson(this.file, { version: 1, repos: { ...saved.repos, [topLevel]: hash } })
  }

  private async trusts(setup: ProjectSetup): Promise<boolean> {
    if (!projectRunsCommands(setup.config)) return true
    return Trusted.parse(await readJsonIfExists(this.file)).repos[setup.topLevel] === setup.hash
  }
}
