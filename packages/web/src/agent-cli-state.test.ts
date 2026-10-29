import { expect, it } from 'vitest'
import { initialAgentCliStatus } from '@conclave/protocol'
import { mergeCliStatuses } from './agent-cli-state'

it('keeps a newer upgrade notification when an older all-agent check reply arrives', () => {
  const checking = { ...initialAgentCliStatus('codex'), revision: 2, phase: 'idle' as const, currentVersion: '1.0.0' }
  const upgraded = { ...checking, revision: 5, phase: 'succeeded' as const, currentVersion: '2.0.0' }
  const other = { ...initialAgentCliStatus('pi'), revision: 1 }
  expect(mergeCliStatuses({ codex: upgraded }, [checking, other])).toEqual({ codex: upgraded, pi: other })
  expect(mergeCliStatuses({}, [checking])).toEqual({ codex: checking })
})
