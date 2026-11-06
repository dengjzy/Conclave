import { describe, expect, it } from 'vitest'
import { geminiSessions } from './gemini-sessions'
import type { NativeSessionExecutor } from '../../native-session'
import { Rejection } from '../../rejection'

const ID = '00000001-0000-4000-8000-000000000000'

describe('Gemini native cleanup', () => {
  it('captures the original storage root before environment or settings change', async () => {
    let directory = '/original/.gemini'
    const source = geminiSessions(() => directory)
    const captured = source.capture?.({ providerSessionId: ID, cwd: '/project' })
    if (!captured) throw new Error('missing capture')
    directory = '/changed/.gemini'
    expect((await source.resolve(captured))?.root).toBe('/original/.gemini')
  })

  it('passes the full UUID and original home/cwd to the native deletion command', async () => {
    const source = geminiSessions(() => '/isolated/.gemini')
    const session = await source.resolve({ providerSessionId: ID, cwd: '/original-project' })
    if (!session) throw new Error('missing session locator')
    const calls: unknown[] = []
    const executor: NativeSessionExecutor = { command: async (...args) => { calls.push(args); return '' }, acp: async () => ({}) }
    await source.remove(session, executor)
    expect(calls).toEqual([[{ command: 'gemini', args: ['--delete-session', ID], env: { GEMINI_CLI_HOME: '/isolated' } }, '/original-project']])
    executor.command = async () => { throw new Rejection('native-session-command-failed', 'Session not found') }
    await source.remove(session, executor)
    executor.command = async () => { throw new Rejection('native-session-command-failed', 'Permission denied') }
    await expect(source.remove(session, executor)).rejects.toThrow('Permission denied')
  })
})
