import { describe, expect, it } from 'vitest'
import { parseHiddenTestPlan } from './hidden-test'

describe('parseHiddenTestPlan', () => {
  const plan = { command: 'pnpm test hidden', timeoutMs: 600_000, files: [{ path: 'tests/a.test.ts', content: 'test' }], note: 'login' }

  it('reads a fenced JSON answer', () => {
    expect(parseHiddenTestPlan(`Here it is:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)).toEqual(plan)
  })

  it('reads the last object when the model shows an example first', () => {
    expect(parseHiddenTestPlan(`example ${JSON.stringify({ command: 'no', files: [] })}\nanswer ${JSON.stringify(plan)}`)).toEqual(plan)
  })

  it('returns null for prose or an invalid plan', () => {
    expect(parseHiddenTestPlan('I would write a test')).toBeNull()
    expect(parseHiddenTestPlan('{"command":"x","files":[]}')).toBeNull()
  })
})
