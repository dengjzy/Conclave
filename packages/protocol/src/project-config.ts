import { z } from 'zod'

// A project's own `.conclave/project.json`, read from the project's checkout rather than a worktree,
// so an agent editing its copy changes nothing that runs.
// copy: files the user names, from the project into each new worktree; nothing is copied by
// default, since what git ignores also holds caches, builds and local credentials.
// setup: runs once in a worktree just made; check: runs before a task goes for review.
export const ProjectCommand = z.string().trim().min(1).max(4000)
export const ProjectConfig = z.object({
  copy: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  setup: ProjectCommand.optional(),
  check: ProjectCommand.optional()
})
export type ProjectConfig = z.infer<typeof ProjectConfig>

export const PROJECT_CONFIG_FILE = 'project.json'

// path: the repo's top level. hash: what trusting it trusts, so a change asks again.
export const ProjectConfigInfo = z.object({
  path: z.string(),
  config: ProjectConfig,
  hash: z.string(),
  trusted: z.boolean()
})
export type ProjectConfigInfo = z.infer<typeof ProjectConfigInfo>

// The config as written: blank lines and entries dropped, and a field left with nothing omitted.
export function tidyProjectConfig(config: ProjectConfig): ProjectConfig {
  const copy = [...new Set((config.copy ?? []).map((entry) => entry.trim()).filter(Boolean))]
  const setup = config.setup?.trim()
  const check = config.check?.trim()
  return { ...(copy.length > 0 ? { copy } : {}), ...(setup ? { setup } : {}), ...(check ? { check } : {}) }
}

// Whether the config runs anything, which is what the user has to trust; copying alone does not.
export function projectRunsCommands(config: ProjectConfig): boolean {
  return Boolean(config.setup || config.check)
}
