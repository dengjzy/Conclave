import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexAccounts, codexEmail } from './codex-account'

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

describe('codexEmail', () => {
  it('reads the email its id token names, and nothing from an API-key sign-in', () => {
    expect(codexEmail({ tokens: { id_token: jwt({ email: 'me@work.com' }) } })).toBe('me@work.com')
    expect(codexEmail({ tokens: null, OPENAI_API_KEY: 'k' })).toBeNull()
    expect(codexEmail({ tokens: { id_token: 'garbage' } })).toBeNull()
  })
})

describe('codexAccounts.prepare', () => {
  let root: string
  let own: string
  let home: string
  const saved = process.env.CODEX_HOME

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-codex-account-'))
    own = path.join(root, 'own')
    home = path.join(root, 'accounts', 'work')
    mkdirSync(path.join(own, 'skills'), { recursive: true })
    for (const name of ['auth.json', 'config.toml', 'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm']) writeFileSync(path.join(own, name), '')
    process.env.CODEX_HOME = own
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
    rmSync(root, { recursive: true, force: true })
  })

  it('links everything of the user’s folder but the sign-in and database journals, and makes the history there', async () => {
    await codexAccounts.prepare(home)
    for (const name of ['config.toml', 'skills', 'state_5.sqlite', 'sessions', 'archived_sessions', 'history.jsonl']) {
      expect(readlinkSync(path.join(home, name)), name).toBe(path.join(own, name))
    }
    expect(existsSync(path.join(own, 'sessions'))).toBe(true)
    for (const name of ['auth.json', 'state_5.sqlite-wal', 'state_5.sqlite-shm']) expect(existsSync(path.join(home, name)), name).toBe(false)
    writeFileSync(path.join(home, 'auth.json'), '{}')
    await codexAccounts.prepare(home)
    expect(lstatSync(path.join(home, 'auth.json')).isSymbolicLink()).toBe(false)
    expect(codexAccounts.env(home)).toEqual({ CODEX_HOME: home })
  })
})
