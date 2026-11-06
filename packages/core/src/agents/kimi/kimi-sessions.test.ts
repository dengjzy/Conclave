import { describe, expect, it } from 'vitest'
import type { NativeSessionExecutor } from '../../native-session'
import { NativeSessionRpcError } from '../../native-session-runner'
import { kimiSessions } from './kimi-sessions'

const ID = '00000001-0000-4000-8000-000000000000'

describe('Kimi native cleanup', () => {
  it('captures the original storage root before environment or settings change', async () => {
    let directory = '/original/.kimi-code'
    const source = kimiSessions(() => directory)
    const captured = source.capture?.({ providerSessionId: ID, cwd: '/project' })
    if (!captured) throw new Error('missing capture')
    directory = '/changed/.kimi-code'
    expect((await source.resolve(captured))?.root).toBe('/original/.kimi-code')
  })

  it('uses the saved home and exact ID without creating a session, accepting only confirmed missing IDs', async () => {
    const source = kimiSessions(() => '/isolated/.kimi-code')
    const session = await source.resolve({ providerSessionId: ID, cwd: '/project' })
    if (!session) throw new Error('missing session locator')
    const calls: unknown[] = []
    const executor: NativeSessionExecutor = { command: async () => '', acp: async (...args) => { calls.push(args); return {} } }
    await source.remove(session, executor)
    expect(calls).toEqual([[{ command: 'kimi', args: ['acp'], env: { KIMI_CODE_HOME: session.root } }, '/project', 'session/delete', { sessionId: ID }]])
    executor.acp = async () => { throw new NativeSessionRpcError(-32602, `Unknown sessionId: ${ID}`) }
    await source.remove(session, executor)
    executor.acp = async () => { throw new NativeSessionRpcError(-32602, 'Invalid params') }
    await expect(source.remove(session, executor)).rejects.toThrow('Invalid params')
  })
})
