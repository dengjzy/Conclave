import { describe, expect, it } from 'vitest'
import { parseFlowPlan } from './plan'

describe('parseFlowPlan', () => {
  it('reads a fenced JSON plan', () => {
    const plan = parseFlowPlan('Here:\n```json\n{"steps":[{"title":"one","instruction":"do one"}]}\n```')
    expect(plan?.steps).toEqual([{ title: 'one', instruction: 'do one', agent: null }])
  })

  it('keeps the agent a step names, and drops one it does not know', () => {
    const plan = parseFlowPlan('{"steps":[{"title":"one","instruction":"do one","agent":"codex"},{"title":"two","instruction":"do two","agent":"nobody"}]}')
    expect(plan?.steps.map((step) => step.agent)).toEqual(['codex', null])
  })

  it('reads the last balanced object when the model shows an example first', () => {
    const plan = parseFlowPlan('Example: {"steps":[{"title":"x","instruction":"y"}]}\nAnswer: {"steps":[{"title":"a","instruction":"b"},{"title":"c","instruction":"d"}]}')
    expect(plan?.steps.map((step) => step.title)).toEqual(['a', 'c'])
  })

  it('rejects an empty plan', () => {
    expect(parseFlowPlan('{"steps":[]}')).toBeNull()
  })
})
