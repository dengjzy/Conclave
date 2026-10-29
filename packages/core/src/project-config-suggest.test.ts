import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { suggestForProject, suggestProjectConfig } from './project-config-suggest'

const project = (files: Record<string, string>) => ({
  has: (name: string) => name in files,
  read: (name: string) => files[name] ?? null
})

describe('suggestProjectConfig', () => {
  it("installs with the lockfile's package manager and checks with the project's own scripts", () => {
    const scripts = JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest run', dev: 'vite' } })
    expect(suggestProjectConfig(project({ 'package.json': scripts, 'pnpm-lock.yaml': '', '.env': '' }))).toEqual({
      config: { copy: ['.env'], setup: 'pnpm install', check: 'pnpm typecheck && pnpm test' },
      from: ['pnpm']
    })
    expect(suggestProjectConfig(project({ 'package.json': scripts, 'package-lock.json': '' })).config).toEqual({ setup: 'npm ci', check: 'npm run typecheck && npm test' })
  })

  it("leaves npm's placeholder test out", () => {
    const placeholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
    expect(suggestProjectConfig(project({ 'package.json': placeholder })).config).toEqual({ setup: 'npm install' })
  })

  it('knows the other kinds of project by their files', () => {
    expect(suggestProjectConfig(project({ 'go.mod': '' })).config).toEqual({ setup: 'go mod download', check: 'go vet ./... && go test ./...' })
    expect(suggestProjectConfig(project({ 'pom.xml': '', mvnw: '' })).config).toEqual({ setup: './mvnw -q -DskipTests dependency:go-offline', check: './mvnw -q test' })
    expect(suggestProjectConfig(project({ 'pyproject.toml': '', 'uv.lock': '' })).config).toEqual({ setup: 'uv sync', check: 'uv run pytest' })
    expect(suggestProjectConfig(project({ 'Cargo.toml': '' })).from).toEqual(['Cargo'])
  })

  it('runs each kind found, one after another', () => {
    const both = suggestProjectConfig(project({ 'go.mod': '', 'package.json': '{}', 'yarn.lock': '' }))
    expect(both.config.setup).toBe('yarn install && go mod download')
    expect(both.from).toEqual(['yarn', 'Go'])
  })

  it('takes a setup written for another worktree tool over a guess', () => {
    const superset = suggestProjectConfig(project({ '.superset/config.json': JSON.stringify({ setup: ['bun install', 'cp $SUPERSET_ROOT_PATH/.env .env'] }), 'package.json': '{}', 'bun.lock': '' }))
    expect(superset.config.setup).toBe('bun install\ncp $SUPERSET_ROOT_PATH/.env .env')
    expect(superset.from).toEqual(['Superset', 'bun'])
    expect(suggestProjectConfig(project({ 'conductor.json': JSON.stringify({ scripts: { setup: 'make setup' } }) })).config).toEqual({ setup: 'make setup' })
  })

  it('has nothing to say about a project it does not know', () => {
    expect(suggestProjectConfig(project({ 'README.md': '' }))).toEqual({ config: {}, from: [] })
  })
})

describe('suggestForProject', () => {
  it("reads the project's top level, from wherever in it it is asked", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-suggest-'))
    try {
      execFileSync('git', ['init', '-q', dir])
      writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n')
      writeFileSync(path.join(dir, '.env'), 'A=1\n')
      mkdirSync(path.join(dir, 'cmd'))
      expect(await suggestForProject(path.join(dir, 'cmd'))).toEqual({ config: { copy: ['.env'], setup: 'go mod download', check: 'go vet ./... && go test ./...' }, from: ['Go'] })
      expect(await suggestForProject(os.tmpdir())).toEqual({ config: {}, from: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
