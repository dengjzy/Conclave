import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordSessionOwnership } from '../../dsh-runtime/src/session-ownership'
import { NATIVE_SESSION_LOG_ENV, ownedSessionLog, readOwnedNativeSessions, readStageOwnedSessions } from './owned-native-sessions'
import { ChatLog } from './chat-log'

describe('session ownership inherited by tool processes', () => {
  it('recovers explicit native child sessions from a persisted stage without treating unrelated sessions as children', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conclave-child-sessions-'))
    try {
      const frame = { method: 'session/update', params: { sessionId: 'parent', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child' } } }
      ChatLog.of(root, 'conversation', 'stage').append([
        { dir: 'in', at: 1, frame }, { dir: 'in', at: 2, frame },
        { dir: 'in', at: 3, frame: { method: 'session/update', params: { sessionId: 'independent', update: { sessionUpdate: 'agent_message_chunk' } } } }
      ])
      expect(readStageOwnedSessions(root, 'conversation', 'stage', 'cursor', '/project')).toEqual([
        { agent: 'cursor', providerSessionId: 'child', cwd: '/project' }
      ])
      ChatLog.of(root, 'conversation', 'opencode').append([{ dir: 'in', at: 4, frame: {
        method: 'session/update', params: { sessionId: 'parent', update: { sessionUpdate: 'agent_message_chunk',
          _meta: { 'opencode/child-session': { id: 'ses_child', parentID: 'ses_parent' } } } }
      } }])
      expect(readStageOwnedSessions(root, 'conversation', 'opencode', 'opencode', '/project')).toEqual([
        { agent: 'opencode', providerSessionId: 'ses_child', cwd: '/project' }
      ])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('keeps no-prompt DSH sessions attributable across processes and restarts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conclave-owned-sessions-'))
    try {
      await mkdir(path.join(root, 'conversation'))
      const env = { [NATIVE_SESSION_LOG_ENV]: ownedSessionLog(root, 'conversation'), DSH_HOME: path.join(root, 'dsh') }
      recordSessionOwnership({ id: 'main-session', cwd: '/project' }, env)
      recordSessionOwnership({ id: 'diagnostic-session', cwd: '/tmp/probe' }, env)
      expect(await readOwnedNativeSessions(root, 'conversation')).toEqual([
        { agent: 'dsh', providerSessionId: 'main-session', cwd: '/project', home: env.DSH_HOME },
        { agent: 'dsh', providerSessionId: 'diagnostic-session', cwd: '/tmp/probe', home: env.DSH_HOME }
      ])
      expect(await readOwnedNativeSessions(root, 'another')).toEqual([])
      expect(() => recordSessionOwnership({ id: 'unmanaged', cwd: '/project' }, {})).not.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
