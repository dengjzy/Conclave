import { beforeEach, describe, expect, it } from 'vitest'
import { AGENT_KINDS, Conversation, Task } from '@conclave/protocol'
import { useCore } from './core-store'
import { defaultAgent } from './default-agent'
import { usePreferences } from './preferences'

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const chat = (n: number, agent: 'claude' | 'codex' | 'cursor', createdAt: number, patch: object = {}) => Conversation.parse({
  id: id(n), title: '会话', titleLocked: false, agent, workspacePath: '/w', projectPaths: [], managedWorkspace: false,
  sessionId: null, createdAt, updatedAt: createdAt, ...patch
})
const task = (key: string, agent: 'claude' | 'codex' | 'cursor' | null, createdAt: number) => Task.parse({
  id: key, title: key, details: '', status: 'pending', repos: [], dependsOn: [], agent, createdAt, updatedAt: createdAt
})

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  usePreferences.setState({ disabledAgents: [] })
})

describe('defaultAgent', () => {
  it('takes the agent of the latest task or conversation the user started', () => {
    expect(defaultAgent({ a: task('a', 'claude', 1) }, { [id(1)]: chat(1, 'codex', 2) })).toBe('codex')
    expect(defaultAgent({ a: task('a', 'claude', 3), b: task('b', null, 4) }, { [id(1)]: chat(1, 'codex', 2) })).toBe('claude')
  })

  it('leaves out conversations that are part of other work or a routine\'s run', () => {
    const conversations = {
      [id(1)]: chat(1, 'cursor', 2, { helperOf: id(9) }), [id(2)]: chat(2, 'cursor', 3, { taskId: 'a' }),
      [id(3)]: chat(3, 'cursor', 4, { discussionId: id(8) }), [id(4)]: chat(4, 'cursor', 5, { squadRunId: id(7) }),
      [id(5)]: chat(5, 'cursor', 6, { routineId: id(6) })
    }
    expect(defaultAgent({ a: task('a', 'claude', 1) }, conversations)).toBe('claude')
  })

  it('never picks an agent turned off here, and leaves the choice open when more than one is on', () => {
    usePreferences.setState({ disabledAgents: ['codex'] })
    expect(defaultAgent({}, { [id(1)]: chat(1, 'codex', 1) })).toBeNull()
    usePreferences.setState({ disabledAgents: AGENT_KINDS.filter((kind) => kind !== 'claude') })
    expect(defaultAgent({}, { [id(1)]: chat(1, 'codex', 1) })).toBe('claude')
  })
})
