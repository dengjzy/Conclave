import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckSpec, Task, Terminal } from '@conclave/protocol'
import { CommandCheckProvider } from './command-check'
import { checkTrust } from './contract-trust'
import type { TerminalService } from './terminal-service'

describe('CommandCheckProvider', () => {
  let dir: string
  let task: Task
  let checks: CheckSpec[]
  let code: number | null
  let output: string
  let ran: { cwd: string; command: string; env?: Record<string, string> }[]
  let active = 0
  let overlap = false
  let provider: CommandCheckProvider

  const terminals = {
    run: async (_id: string, cwd: string, command: string, options: { env?: Record<string, string> } = {}): Promise<Terminal> => {
      ran.push({ cwd, command, env: options.env })
      active += 1
      if (active > 1) overlap = true
      return { id: command, sessionId: command, cwd, title: command, createdAt: 0, conversationId: 'c', command }
    },
    waitForExit: async () => { if (active > 1) overlap = true; active = Math.max(0, active - 1); return code },
    read: async (_id: string, id: string) => ({ id, command: id, output, truncated: false, running: false, exitCode: code ?? 0 }),
    kill: async () => {}
  } as unknown as TerminalService

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-command-'))
    task = {
      id: 't', title: '', details: '', status: 'running', agent: 'claude',
      repos: [{ path: '/code', worktreePath: dir, branch: 'b', startRef: null, start: null }], dependsOn: []
    } as unknown as Task
    checks = [{ repo: '/code', command: 'pnpm test', timeoutMs: 600_000, required: true }]
    code = 0
    output = 'ok'
    ran = []
    active = 0
    overlap = false
    provider = new CommandCheckProvider(terminals)
    mkdirSync(path.join(dir, '.conclave'))
    mkdirSync(path.join(dir, 'scripts'))
    writeFileSync(path.join(dir, '.conclave', 'project.json'), JSON.stringify({ check: 'node scripts/check.mjs' }))
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'node scripts/check.mjs' } }))
    writeFileSync(path.join(dir, 'scripts', 'check.mjs'), 'console.log("ok")')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs the contract command in the task worktree', async () => {
    const results = await provider.run(task, 'c', checks)
    expect(results[0]).toMatchObject({ status: 'pass', exitCode: 0, repo: '/code' })
    expect(ran[0]).toMatchObject({ cwd: dir, command: 'pnpm test' })
  })

  it('runs a relative cwd inside the worktree and passes env', async () => {
    checks = [{ ...checks[0]!, cwd: 'packages/web', env: { CI: '1' } }]
    await provider.run(task, 'c', checks)
    expect(ran[0]?.cwd).toBe(path.join(dir, 'packages/web'))
    expect(ran[0]?.env).toEqual({ CI: '1' })
  })

  it('refuses a cwd outside the worktree', async () => {
    checks = [{ ...checks[0]!, cwd: '../outside' }]
    const results = await provider.run(task, 'c', checks)
    expect(results[0]?.status).toBe('blocked')
    expect(ran).toHaveLength(0)
  })

  it('reports a failure with its tail', async () => {
    code = 1
    output = 'test failed'
    const results = await provider.run(task, 'c', checks)
    expect(results[0]).toMatchObject({ status: 'fail', exitCode: 1 })
    expect(results[0]?.failures[0]).toContain('test failed')
  })

  it('runs checks for the same repo one at a time', async () => {
    checks = [{ ...checks[0]!, command: 'pnpm build' }, { ...checks[0]!, command: 'pnpm test' }]
    await provider.run(task, 'c', checks)
    expect(overlap).toBe(false)
    expect(ran.map((each) => each.command)).toEqual(['pnpm build', 'pnpm test'])
  })

  it('reports a timeout as blocked', async () => {
    code = null
    const results = await provider.run(task, 'c', checks)
    expect(results[0]).toMatchObject({ status: 'blocked', exitCode: null })
    expect(results[0]?.failures[0]).toContain('超时')
  })

  it('runs a contract check whose script and package.json are unchanged since the save', async () => {
    checks = [{ ...checks[0]!, command: 'node scripts/check.mjs' }]
    const trustedHash = checkTrust(checks, (repo) => ({ root: dir, repo })).hash
    const results = await provider.run(task, 'c', checks, trustedHash)
    expect(results[0]).toMatchObject({ status: 'pass', exitCode: 0 })
    expect(ran).toHaveLength(1)
  })

  it('blocks, without running, when the check script changed after the save', async () => {
    checks = [{ ...checks[0]!, command: 'node scripts/check.mjs' }]
    const trustedHash = checkTrust(checks, (repo) => ({ root: dir, repo })).hash
    writeFileSync(path.join(dir, 'scripts', 'check.mjs'), 'console.log("cheat")')

    const results = await provider.run(task, 'c', checks, trustedHash)
    expect(results[0]?.status).toBe('blocked')
    expect(results[0]?.failures[0]).toContain('检查文件已更改')
    expect(results[0]?.failures[0]).toContain('scripts/check.mjs')
    expect(ran).toHaveLength(0)
  })

  it('blocks, without running, when package.json changed after the save', async () => {
    checks = [{ ...checks[0]!, command: 'node scripts/check.mjs' }]
    const trustedHash = checkTrust(checks, (repo) => ({ root: dir, repo })).hash
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'true' } }))

    const results = await provider.run(task, 'c', checks, trustedHash)
    expect(results[0]?.status).toBe('blocked')
    expect(results[0]?.failures[0]).toContain('检查文件已更改')
    expect(ran).toHaveLength(0)
  })

  it('does not treat a checked artifact as a trusted script', async () => {
    checks = [{ ...checks[0]!, command: 'test -f SELFTEST.md' }]
    const trustedHash = checkTrust(checks, (repo) => ({ root: dir, repo })).hash
    writeFileSync(path.join(dir, 'SELFTEST.md'), 'ok')
    const results = await provider.run(task, 'c', checks, trustedHash)
    expect(results[0]).toMatchObject({ status: 'pass', exitCode: 0 })
    expect(ran).toHaveLength(1)
  })

  it('blocks when a trusted script was removed after the save', async () => {
    checks = [{ ...checks[0]!, command: 'node scripts/check.mjs' }]
    const trustedHash = checkTrust(checks, (repo) => ({ root: dir, repo })).hash
    rmSync(path.join(dir, 'scripts', 'check.mjs'))

    const results = await provider.run(task, 'c', checks, trustedHash)
    expect(results[0]?.status).toBe('blocked')
    expect(ran).toHaveLength(0)
  })

  it('keeps running a contract saved before trust hashes existed', async () => {
    checks = [{ ...checks[0]!, command: 'node scripts/check.mjs' }]
    const results = await provider.run(task, 'c', checks)
    expect(results[0]).toMatchObject({ status: 'pass', exitCode: 0 })
    expect(ran).toHaveLength(1)
  })
})
