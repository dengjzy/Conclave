import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Terminal } from '@conclave/protocol'
import type { TrustedSetup } from './project-config'
import { copyListed, WorktreeSetup } from './worktree-setup'

describe('copyListed', () => {
  let dir: string
  let source: string
  let worktree: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-copy-'))
    source = path.join(dir, 'app')
    worktree = path.join(dir, 'wt')
    mkdirSync(source)
    mkdirSync(worktree)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('copies listed files and folders, skipping what is missing or already there', async () => {
    writeFileSync(path.join(source, '.env'), 'SECRET=1')
    mkdirSync(path.join(source, 'config'))
    writeFileSync(path.join(source, 'config', 'local.json'), '{}')
    writeFileSync(path.join(source, 'tracked.txt'), 'project')
    writeFileSync(path.join(worktree, 'tracked.txt'), 'worktree')

    const copied = await copyListed(source, worktree, ['.env', 'config', 'tracked.txt', 'missing.env'])
    expect(copied).toEqual(['.env', 'config'])
    expect(readFileSync(path.join(worktree, '.env'), 'utf8')).toBe('SECRET=1')
    expect(existsSync(path.join(worktree, 'config', 'local.json'))).toBe(true)
    expect(readFileSync(path.join(worktree, 'tracked.txt'), 'utf8')).toBe('worktree')
  })

  it('copies nothing from outside the project', async () => {
    writeFileSync(path.join(dir, 'outside'), 'x')
    symlinkSync(path.join(dir, 'outside'), path.join(source, 'link'))
    expect(await copyListed(source, worktree, ['../outside', path.join(dir, 'outside'), 'link'])).toEqual([])
  })
})

describe('WorktreeSetup', () => {
  // Runs nothing: each command ends with the code it is given.
  function fakeTerminals(codes: Record<string, number | null>) {
    const ran: { cwd: string; command: string; purpose?: string; env?: Record<string, string> }[] = []
    const commands = new Map<string, string>()
    const closed: string[] = []
    return {
      ran,
      closed,
      run: async (conversationId: string, cwd: string, command: string, options: { purpose?: 'setup' | 'check'; env?: Record<string, string> } = {}): Promise<Terminal> => {
        ran.push({ cwd, command, purpose: options.purpose, env: options.env })
        const id = randomUUID()
        commands.set(id, command)
        return { id, sessionId: cwd, cwd, title: command, createdAt: 0, conversationId, command }
      },
      waitForExit: async (id: string) => codes[commands.get(id) ?? ''] ?? 0,
      read: async (_: string, id: string) => ({ id, command: '', output: 'boom', truncated: false, running: false, exitCode: 1 }),
      kill: async (id: string) => { closed.push(commands.get(id) ?? '') }
    }
  }
  const setup = (repoPath: string, config: TrustedSetup['config']): TrustedSetup => ({ repoPath, topLevel: repoPath, config, hash: 'h' })

  it('runs setup in each new worktree with the project and worktree in its environment', async () => {
    const terminals = fakeTerminals({ 'pnpm install': 1 })
    const runner = new WorktreeSetup({ requireTrusted: async () => [] }, terminals)
    const dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-setup-'))
    try {
      const failures = await runner.setUp('conv', [{ topLevel: dir, dir }], [setup(dir, { setup: 'pnpm install' })])
      expect(terminals.ran).toEqual([{ cwd: dir, command: 'pnpm install', purpose: 'setup', env: { CONCLAVE_ROOT_PATH: dir, CONCLAVE_WORKTREE_PATH: dir } }])
      expect(failures).toHaveLength(1)
      expect(failures[0]).toContain('退出码 1')
      expect(failures[0]).toContain('boom')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checks where the agent works, and has nothing to say when no project has a check', async () => {
    const terminals = fakeTerminals({ 'pnpm test': 2 })
    const configs = [setup('/code/app', { check: 'pnpm test' }), setup('/code/web', { setup: 'x' })]
    const runner = new WorktreeSetup({ requireTrusted: async (paths) => configs.filter((each) => paths.includes(each.repoPath)) }, terminals)
    const failures = await runner.check('conv', [{ path: '/code/app', dir: '/wt/app' }, { path: '/code/web', dir: '/wt/web' }])
    expect(terminals.ran.map(({ cwd, purpose }) => ({ cwd, purpose }))).toEqual([{ cwd: '/wt/app', purpose: 'check' }])
    expect(failures).toHaveLength(1)
    expect(await runner.check('conv', [{ path: '/code/web', dir: '/wt/web' }])).toBeNull()
  })

  it('closes the tab of a run that passed and keeps one that failed', async () => {
    const terminals = fakeTerminals({ 'pnpm test': 1 })
    const runner = new WorktreeSetup({ requireTrusted: async () => [] }, terminals)
    const dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-setup-'))
    try {
      await runner.setUp('conv', [{ topLevel: dir, dir }], [setup(dir, { setup: 'pnpm install' })])
      await runner.setUp('conv', [{ topLevel: dir, dir }], [setup(dir, { setup: 'pnpm test' })])
      expect(terminals.closed).toEqual(['pnpm install'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
