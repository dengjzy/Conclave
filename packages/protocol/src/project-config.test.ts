import { describe, expect, it } from 'vitest'
import { ProjectConfig, projectRunsCommands } from './project-config'

describe('ProjectConfig', () => {
  it('takes every field as optional', () => {
    expect(ProjectConfig.parse({})).toEqual({})
    expect(ProjectConfig.parse({ copy: ['.env'], setup: 'pnpm install', check: 'pnpm test' })).toEqual({ copy: ['.env'], setup: 'pnpm install', check: 'pnpm test' })
  })

  it('refuses empty commands and paths', () => {
    expect(ProjectConfig.safeParse({ setup: '  ' }).success).toBe(false)
    expect(ProjectConfig.safeParse({ copy: [''] }).success).toBe(false)
  })

  it('needs trust only for commands', () => {
    expect(projectRunsCommands({ copy: ['.env'] })).toBe(false)
    expect(projectRunsCommands({ check: 'pnpm test' })).toBe(true)
  })
})
