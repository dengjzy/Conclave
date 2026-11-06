import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cursorSessions } from './cursor-sessions'
import type { NativeSessionExecutor } from '../../native-session'

let root: string
const ID = '00000001-0000-4000-8000-000000000000'
const executor: NativeSessionExecutor = { command: async () => '', acp: async () => ({}) }
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-cursor-sessions-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('Cursor native cleanup', () => {
  it('captures the exact chats directory before settings change', async () => {
    let directory = path.join(root, 'original-chats')
    mkdirSync(path.join(directory, 'workspace', ID), { recursive: true })
    const source = cursorSessions(() => directory)
    const captured = source.capture?.({ providerSessionId: ID, cwd: '/project' })
    if (!captured) throw new Error('missing capture')
    directory = path.join(root, 'changed-chats')
    expect((await source.resolve(captured))?.root).toBe(path.join(root, 'original-chats'))
  })

  it('removes only the exact native session directory and is idempotent', async () => {
    const dir = path.join(root, 'workspace-hash', ID), other = path.join(root, 'workspace-hash', 'other')
    mkdirSync(dir, { recursive: true }); mkdirSync(other)
    writeFileSync(path.join(dir, 'store.db'), 'session data')
    const source = cursorSessions(() => root)
    const session = await source.resolve({ providerSessionId: ID, cwd: '/project' })
    if (!session) throw new Error('missing session')
    await source.remove(session, executor)
    await source.remove(session, executor)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('refuses duplicate IDs and symbolic links rather than following them outside storage', async () => {
    const source = cursorSessions(() => root)
    mkdirSync(path.join(root, 'one', ID), { recursive: true })
    mkdirSync(path.join(root, 'two', ID), { recursive: true })
    await expect(source.resolve({ providerSessionId: ID, cwd: '/project' })).rejects.toMatchObject({ reason: 'native-session-ambiguous' })
    rmSync(path.join(root, 'two'), { recursive: true })
    rmSync(path.join(root, 'one', ID), { recursive: true })
    symlinkSync(os.tmpdir(), path.join(root, 'one', ID), 'dir')
    await expect(source.resolve({ providerSessionId: ID, cwd: '/project' })).rejects.toMatchObject({ reason: 'native-session-path-invalid' })
    await expect(source.resolve({ providerSessionId: '../escape', cwd: '/project' })).rejects.toMatchObject({ reason: 'native-session-id-invalid' })
  })
})
