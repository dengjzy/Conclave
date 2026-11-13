import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeSession, NativeSessionExecutor } from '../../native-session'
import { antigravity } from './antigravity-adapter'
import { antigravityAccounts } from './antigravity-account'
import * as runtime from './antigravity-runtime'

const ID = '11111111-1111-4111-8111-111111111111'
let root: string
let own: string
let account: string
beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conclave-antigravity-catalog-')))
  own = path.join(root, 'own'); account = path.join(root, 'account')
  vi.stubEnv('GEMINI_HOME', own)
  await antigravityAccounts.prepare(account)
  writeFileSync(path.join(account, 'antigravity-cli', 'antigravity-oauth-token'), '{}')
  vi.spyOn(runtime, 'requireAntigravity').mockResolvedValue('/usr/local/bin/agy')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

it.each([false, true])('registers and cleans the daemon probe in its selected account before files are flushed (failure=%s)', async (fail) => {
  const events: string[] = []
  const registered: NativeSession[] = []
  const executor: NativeSessionExecutor = {
    command: async () => { throw new Error('unexpected command') },
    acp: async () => { throw new Error('unexpected ACP cleanup command') },
    catalog: async (_driver, command, cwd, onSession) => {
      events.push('daemon-probe')
      expect(command).toMatchObject({ command: '/usr/local/bin/agy', args: ['acp', '--stdio', '--gemini-dir', account], env: { GEMINI_HOME: account } })
      expect(cwd).toBe(root)
      await onSession?.(ID, 'daemon-probe-session')
      if (fail) throw new Error('probe failed')
      return { models: [] }
    },
    register: async (agent, session, daemonSessionId) => {
      events.push('register')
      expect(agent).toBe('antigravity')
      expect(daemonSessionId).toBe('daemon-probe-session')
      expect(session).toMatchObject({ id: ID, root: path.join(own, 'antigravity-cli'), artifacts: [{ root: path.join(account, 'antigravity-cli', 'brain'), locator: path.join(account, 'antigravity-cli', 'brain', ID) }] })
      registered.push(session)
    },
    cleanup: async (agent, session) => {
      events.push('cleanup')
      expect(agent).toBe('antigravity')
      expect(session).toBe(registered[0])
    }
  }
  const result = antigravity.catalog?.(root, executor, antigravityAccounts.env(account))
  if (fail) await expect(result).rejects.toThrow('probe failed')
  else await expect(result).resolves.toEqual({ models: [] })
  expect(events).toEqual(['daemon-probe', 'register', 'cleanup'])
  expect(existsSync(path.join(own, 'antigravity-cli', 'conversations', `${ID}.db`))).toBe(false)
})

it('does not start a catalog probe without the daemon ownership and cleanup capabilities', async () => {
  const catalog = vi.fn(async () => ({ models: [] }))
  const partial = { command: async () => '', acp: async () => null, catalog }
  expect(await antigravity.catalog?.(root, undefined, antigravityAccounts.env(account))).toBeNull()
  expect(await antigravity.catalog?.(root, partial, antigravityAccounts.env(account))).toBeNull()
  expect(catalog).not.toHaveBeenCalled()
  expect(runtime.requireAntigravity).not.toHaveBeenCalled()
})
