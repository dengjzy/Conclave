import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@conclave/protocol'
import { UNATTENDED_DENIAL, UNATTENDED_QUESTION, unattendedAnswer } from './unattended-answer'

const base = { stageId: 'stage', at: 1, revision: 1 }
const approval = (patch: Partial<Extract<ChatItem, { kind: 'approval' }>> = {}): ChatItem => ({
  ...base, id: 'a', kind: 'approval', requestId: 'r', tool: 'Bash', title: 'rm -rf build', detail: null, toolItemId: null, decisions: ['allow', 'allowForSession', 'deny'], resolution: null, ...patch
})
const choices = [
  { id: 'once', label: 'Allow once', decision: 'allow' as const, grants: [] },
  { id: 'always', label: 'Always allow', decision: 'allowForSession' as const, grants: [{ kind: 'other' as const, values: ['Always allow'], scope: 'agent' as const, behavior: 'allow' as const }] },
  { id: 'never', label: 'Always reject', decision: 'deny' as const, grants: [{ kind: 'other' as const, values: ['Always reject'], scope: 'agent' as const, behavior: 'deny' as const }] },
  { id: 'reject', label: 'Reject', decision: 'deny' as const, grants: [] }
]

describe('unattendedAnswer', () => {
  it('refuses with word to work around it in automatic mode, by the plain no among the choices', () => {
    expect(unattendedAnswer(approval(), 'acceptEdits')).toEqual({ decision: 'deny', message: UNATTENDED_DENIAL })
    expect(unattendedAnswer(approval({ choices }), 'acceptEdits')).toEqual({ decision: 'deny', message: UNATTENDED_DENIAL, choice: 'reject' })
  })

  it('allows once in allow-everything mode, never a yes that outlasts the run', () => {
    expect(unattendedAnswer(approval(), 'bypass')).toEqual({ decision: 'allow' })
    expect(unattendedAnswer(approval({ choices }), 'bypass')).toEqual({ decision: 'allow', choice: 'once' })
  })

  it('approves a plan, as a scheduled run approves the one it finds', () => {
    expect(unattendedAnswer(approval({ tool: 'ExitPlanMode' }), 'acceptEdits')).toEqual({ decision: 'allowForSession' })
  })

  it('leaves a question unanswered, telling the agent to assume and go on', () => {
    const question: ChatItem = { ...base, id: 'q', kind: 'question', requestId: 'q', questions: [], answers: null, resolution: null }
    expect(unattendedAnswer(question, 'bypass')).toEqual({ decision: 'deny', message: UNATTENDED_QUESTION })
    expect(unattendedAnswer({ ...question, async: true }, 'bypass')).toBeNull()
  })

  it('answers nothing already answered', () => {
    expect(unattendedAnswer(approval({ resolution: 'denied' }), 'bypass')).toBeNull()
  })
})
