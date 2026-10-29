import { beforeEach, describe, expect, it } from 'vitest'
import { cancelHandoff, chooseHandoffMode, chooseHandoffModel, proposeHandoff, useHandoffs } from './chat-handoff'

describe('pending handoffs', () => {
  beforeEach(() => useHandoffs.setState({}, true))

  it('keeps one per conversation, and picking another agent starts its model over', () => {
    proposeHandoff('a', 'codex')
    chooseHandoffModel('a', { model: 'gpt-5', effort: 'high' })
    proposeHandoff('b', 'claude')
    expect(useHandoffs.getState()).toEqual({ a: { agent: 'codex', model: 'gpt-5', effort: 'high' }, b: { agent: 'claude' } })
    proposeHandoff('a', 'cursor')
    expect(useHandoffs.getState().a).toEqual({ agent: 'cursor' })
  })

  it('keeps the mode picked when the model changes, and starts it over with another agent', () => {
    proposeHandoff('a', 'codex')
    chooseHandoffMode('a', 'readOnly')
    chooseHandoffModel('a', { model: 'gpt-5' })
    expect(useHandoffs.getState().a).toEqual({ agent: 'codex', permissionMode: 'readOnly', model: 'gpt-5' })
    chooseHandoffModel('a', {})
    expect(useHandoffs.getState().a).toEqual({ agent: 'codex', permissionMode: 'readOnly' })
    proposeHandoff('a', 'claude')
    expect(useHandoffs.getState().a).toEqual({ agent: 'claude' })
  })

  it('takes a model or mode only for a handoff being set up, and forgets one called off', () => {
    chooseHandoffModel('a', { model: 'gpt-5' })
    chooseHandoffMode('a', 'plan')
    expect(useHandoffs.getState().a).toBeUndefined()
    proposeHandoff('a', 'codex')
    cancelHandoff('a')
    expect(useHandoffs.getState()).toEqual({})
  })
})
