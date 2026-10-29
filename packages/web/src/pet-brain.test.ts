import { describe, expect, it } from 'vitest'
import { freshMemory, mayRoam, pickBit, remember, restMs, type Bit, type Context } from './pet-brain'

const context = (over: Partial<Context> = {}): Context => ({
  now: 100_000, level: 'medium', mood: 'idle', reduced: false, typingUntil: 0, idleFor: 5_000,
  pointer: null, pointerDistance: null, urge: null, message: null, on: 'floor', random: () => 0.5, ...over
})

const bit = (id: string, score: number, over: Partial<Bit<null>> = {}): Bit<null> => ({ id, cooldownMs: 0, score: () => score, run: async () => {}, ...over })

const tally = (bits: Bit<null>[], c: Context, memory = freshMemory(), draws = 400) => {
  const counts = new Map<string, number>()
  for (let i = 0; i < draws; i++) {
    const picked = pickBit(bits, { ...c, random: () => ((i * 7919) % draws) / draws }, memory)
    if (picked) counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1)
  }
  return counts
}

describe('pickBit', () => {
  it('always yields before a message and speaks before idle behavior regardless of randomness or memory', () => {
    const bits = [bit('stroll', 1000), bit('speak', 60), bit('yield', 100)]
    const memory = remember(freshMemory(), 'yield', 99_000)
    const message = { key: 'waiting', text: 'Needs input', anchor: () => null, holdMs: null }
    for (const random of [() => 0, () => .99]) {
      expect(pickBit(bits, context({ urge: 'yield', message, random }), memory)?.id).toBe('yield')
      expect(pickBit(bits, context({ message, random }), memory)?.id).toBe('speak')
    }
  })
  it('draws in proportion to the scores', () => {
    const counts = tally([bit('a', 3), bit('b', 1)], context())
    expect(counts.get('a')).toBeGreaterThan(250)
    expect(counts.get('b')).toBeGreaterThan(50)
  })

  it('leaves out what scores nothing, is cooling down, or is off at this level', () => {
    const memory = remember(freshMemory(), 'cooling', 99_000)
    const bits = [bit('zero', 0), bit('cooling', 5, { cooldownMs: 10_000 }), bit('quiet-off', 5, { weight: { quiet: 0 } }), bit('ok', 1)]
    expect(pickBit(bits, context({ level: 'quiet' }), memory)?.id).toBe('ok')
  })

  it('returns null with nothing to do', () => {
    expect(pickBit([bit('zero', 0)], context(), freshMemory())).toBeNull()
  })

  it('seldom repeats what it just did', () => {
    const memory = remember(freshMemory(), 'a', 90_000)
    const counts = tally([bit('a', 1), bit('b', 1)], context(), memory)
    expect(counts.get('a') ?? 0).toBeLessThan(80)
  })

  it('weighs the levels differently, not just more often', () => {
    const bits = [bit('nap', 1, { weight: { quiet: 3, lively: 0.5 } }), bit('stroll', 1, { weight: { quiet: 0, lively: 1.5 } })]
    expect(tally(bits, context({ level: 'quiet' })).get('stroll')).toBeUndefined()
    const lively = tally(bits, context({ level: 'lively' }))
    expect(lively.get('stroll')).toBeGreaterThan(lively.get('nap') ?? 0)
  })
})

describe('remember', () => {
  it('keeps the last few and when each was done', () => {
    let memory = freshMemory()
    for (const id of ['a', 'b', 'c', 'd']) memory = remember(memory, id, 1)
    expect(memory.last).toBe('d')
    expect(memory.recent).toEqual(['d', 'c', 'b'])
    expect(memory.doneAt.get('a')).toBe(1)
  })
})

describe('mayRoam and restMs', () => {
  it('can explore while working but keeps waiting users and reduced motion still', () => {
    expect(mayRoam(context())).toBe(true)
    expect(mayRoam(context({ mood: 'running' }))).toBe(true)
    expect(mayRoam(context({ mood: 'waiting' }))).toBe(false)
    expect(mayRoam(context({ typingUntil: 100_001 }))).toBe(false)
    expect(mayRoam(context({ reduced: true }))).toBe(false)
  })

  it('rests longer the quieter the level', () => {
    expect(restMs('lively', () => 0.5)).toBeLessThan(restMs('medium', () => 0.5))
    expect(restMs('medium', () => 0.5)).toBeLessThan(restMs('quiet', () => 0.5))
  })
})
