import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, lstatSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeAccounts, claudeKeychainService, mergedGlobalConfig } from './claude-account'

describe('claudeKeychainService', () => {
  it('keys an account by the sha256 of its folder, as Claude Code 2.1 names its keychain item', () => {
    expect(claudeKeychainService(undefined)).toBe('Claude Code-credentials')
    expect(claudeKeychainService('/tmp/acct')).toBe('Claude Code-credentials-b84634c1')
    // NFC first: a decomposed é names the same item as a composed one.
    expect(claudeKeychainService('/tmp/cafe\u0301')).toBe(claudeKeychainService('/tmp/caf\u00e9'))
  })
})

describe('mergedGlobalConfig', () => {
  it('takes the user’s MCP servers and project trust, keeping the account’s sign-in', () => {
    const merged = mergedGlobalConfig(
      { mcpServers: { a: {} }, projects: { '/p': { hasTrustDialogAccepted: true, allowedTools: ['x'] } }, oauthAccount: { emailAddress: 'me@own' } },
      { oauthAccount: { emailAddress: 'me@work' }, userID: 'u', projects: { '/p': { lastCost: 3 } } }
    )
    expect(merged).toEqual({
      oauthAccount: { emailAddress: 'me@work' }, userID: 'u', hasCompletedOnboarding: true, mcpServers: { a: {} },
      projects: { '/p': { lastCost: 3, hasTrustDialogAccepted: true } }
    })
  })
})

describe('claudeAccounts.prepare', () => {
  let root: string
  let own: string
  let home: string
  const saved = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-claude-account-'))
    own = path.join(root, 'own')
    home = path.join(root, 'accounts', 'work')
    mkdirSync(path.join(own, 'skills'), { recursive: true })
    writeFileSync(path.join(own, 'settings.json'), '{"model":"opus"}')
    writeFileSync(path.join(own, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'x' } } }))
    process.env.CLAUDE_CONFIG_DIR = own
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    rmSync(root, { recursive: true, force: true })
  })

  it('links history and the user’s skills, copies settings, imports CLAUDE.md, and keeps its own sign-in', async () => {
    await claudeAccounts.prepare(home)
    expect(readlinkSync(path.join(home, 'projects'))).toBe(path.join(own, 'projects'))
    expect(existsSync(path.join(own, 'projects'))).toBe(true)
    expect(readlinkSync(path.join(home, 'skills'))).toBe(path.join(own, 'skills'))
    expect(existsSync(path.join(home, 'plugins'))).toBe(false)
    expect(existsSync(path.join(home, 'sessions'))).toBe(false)
    expect(lstatSync(path.join(home, 'settings.json')).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe('{"model":"opus"}')
    expect(readFileSync(path.join(home, 'CLAUDE.md'), 'utf8')).toBe(`@${path.join(own, 'CLAUDE.md')}\n`)
    expect(JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true, mcpServers: { a: { command: 'x' } } })
    expect(claudeAccounts.env(home)).toEqual({ CLAUDE_CONFIG_DIR: home })
  })

  it('takes in what was written into the account’s own history before it was linked, and can run again', async () => {
    mkdirSync(path.join(home, 'projects', '-p'), { recursive: true })
    writeFileSync(path.join(home, 'projects', '-p', 's.jsonl'), '{}')
    await claudeAccounts.prepare(home)
    await claudeAccounts.prepare(home)
    expect(lstatSync(path.join(home, 'projects')).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(own, 'projects', '-p', 's.jsonl'), 'utf8')).toBe('{}')
  })
})
