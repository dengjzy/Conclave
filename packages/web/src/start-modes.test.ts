import { describe, expect, it } from 'vitest'
import { defaultStartMode, modeLabel, startModes } from './components/ChatOptionsBar'
import { handoffMode } from './components/ChatHandoff'

const model = (autoMode?: boolean) => ({ id: 'opus', label: 'Opus', description: null, efforts: [], isDefault: true, ...(autoMode === undefined ? {} : { autoMode }) })

describe('startModes', () => {
  it('shows Cursor native modes, without auto or bypass', () => {
    const modes = startModes('cursor', model(true))
    expect(modes).toEqual(['ask', 'plan', 'readOnly'])
    expect(modes.map((mode) => modeLabel('cursor', mode))).toEqual(['Agent', 'Plan', 'Ask'])
    expect(defaultStartMode('cursor', modes)).toBe('ask')
  })
  it('offers auto where the model takes it, and bypass where the agent has it', () => {
    expect(startModes('claude', model(true))).toEqual(['ask', 'acceptEdits', 'plan', 'auto', 'bypass'])
    expect(startModes('claude', model())).toEqual(['ask', 'acceptEdits', 'plan', 'bypass'])
    expect(startModes('claude', undefined)).toEqual(['ask', 'acceptEdits', 'plan', 'bypass'])
    expect(startModes('codex', model())).toEqual(['acceptEdits', 'ask', 'plan', 'readOnly', 'bypass'])
    expect(startModes('codex', model(true))).toEqual(['acceptEdits', 'ask', 'plan', 'readOnly', 'bypass'])
  })

  it('defaults each agent independently and falls back when Claude auto is unavailable', () => {
    expect(defaultStartMode('claude', startModes('claude', model(true)))).toBe('auto')
    expect(defaultStartMode('claude', startModes('claude', model()))).toBe('ask')
    expect(defaultStartMode('codex', startModes('codex', model()))).toBe('acceptEdits')
  })
})

describe('handoffMode', () => {
  it('takes the mode picked, else the chat\'s where the agent has it, else its default', () => {
    const cursor = startModes('cursor', model())
    expect(handoffMode('cursor', cursor, 'readOnly', 'plan')).toBe('readOnly')
    expect(handoffMode('cursor', cursor, undefined, 'plan')).toBe('plan')
    // Cursor has no accept-edits mode: the handoff shows it going to Cursor's default instead.
    expect(handoffMode('cursor', cursor, undefined, 'acceptEdits')).toBe('ask')
    expect(handoffMode('codex', startModes('codex', model()), 'auto', null)).toBe('acceptEdits')
  })
})
