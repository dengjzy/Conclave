import { describe, expect, it, vi } from 'vitest'
import { petBits } from './pet-bits'
import { freshMemory, pickBit, remember, type Context } from './pet-brain'
import { Interrupted, type StageApi } from './pet-stage-api'

const context = (over: Partial<Context> = {}): Context => ({
  now: 100_000, level: 'medium', mood: 'idle', reduced: false, typingUntil: 0, idleFor: 5_000,
  pointer: null, pointerDistance: null, urge: null, message: null, on: 'floor', random: () => .5, ...over
})

function wallStage(): StageApi {
  return {
    spot: () => ({ x: 240, y: 600 }), facing: () => 1,
    surface: () => ({ kind: 'wall', inward: 1 }),
    bounds: () => ({ left: 0, top: 0, right: 1000, bottom: 720 }),
    perches: () => [{ id: 'divider', kind: 'wall', from: { x: 240, y: 40 }, to: { x: 240, y: 680 }, inward: 1 }],
    home: () => ({ x: 120, y: 700 }), pointer: () => null, random: () => .5,
    standingSpot: () => ({ x: 240, y: 320 }),
    pose: vi.fn(), look: vi.fn(), clip: vi.fn(),
    face: vi.fn(async () => {}), walkTo: vi.fn(async () => {}), hopTo: vi.fn(async () => {}),
    peekFrom: vi.fn(async () => {}), once: vi.fn(async () => {}),
    wait: vi.fn(async () => {}), say: vi.fn(async () => {})
  }
}

describe('resting on a wall', () => {
  it.each([
    ['relocate', 4_000, 12_000],
    ['hang', 5_000, 12_000]
  ] as const)('%s keeps its feet on the wall and looks around during the pause', async (id, min, max) => {
    const bit = petBits().find((bit) => bit.id === id)
    if (!bit) throw new Error(`missing ${id} behavior`)
    const api = wallStage()
    await bit.run(api, context({ on: 'wall' }))

    expect(api.pose).toHaveBeenLastCalledWith('idle')
    expect(api.pose).not.toHaveBeenCalledWith('hang')
    expect(api.pose).not.toHaveBeenCalledWith('jumping')
    expect(api.look).toHaveBeenNthCalledWith(1, -.65, expect.any(Number))
    expect(api.look).toHaveBeenNthCalledWith(2, .65, expect.any(Number))
    expect(api.look).toHaveBeenLastCalledWith(0, 0)
    const duration = vi.mocked(api.wait).mock.calls.reduce((sum, [ms]) => sum + ms, 0)
    expect(duration).toBeGreaterThanOrEqual(min)
    expect(duration).toBeLessThanOrEqual(max)
    expect(api.hopTo).not.toHaveBeenCalled()
    expect(api.surface()).toEqual({ kind: 'wall', inward: 1 })
  })

  it('keeps the working mood after arriving at a wall', async () => {
    const relocate = petBits().find((bit) => bit.id === 'relocate')
    if (!relocate) throw new Error('missing relocate behavior')
    const api = wallStage()
    await relocate.run(api, context({ on: 'wall', mood: 'running' }))
    expect(api.pose).toHaveBeenLastCalledWith('running')
  })

  it.each(['relocate', 'hang'])('%s stops looking around when interrupted', async (id) => {
    const bit = petBits().find((bit) => bit.id === id)
    if (!bit) throw new Error(`missing ${id} behavior`)
    const api = wallStage()
    vi.mocked(api.wait).mockRejectedValueOnce(new Interrupted())
    await expect(bit.run(api, context({ on: 'wall' }))).rejects.toBeInstanceOf(Interrupted)
    expect(api.look).toHaveBeenCalledTimes(1)
    expect(api.pose).toHaveBeenLastCalledWith('idle')
  })
})

describe('peek behavior', () => {
  it('stays out of quiet mode, typing, working, attention and reduced motion', () => {
    const peek = petBits().find((bit) => bit.id === 'peek')
    if (!peek) throw new Error('missing peek behavior')
    expect(peek.score(context())).toBeGreaterThan(0)
    for (const over of [{ typingUntil: 100_001 }, { reduced: true }, { mood: 'running' }, { mood: 'waiting' }, { idleFor: 1000 }] as const) {
      expect(peek.score(context(over))).toBe(0)
    }
    expect(pickBit([peek], context({ level: 'quiet' }), freshMemory())).toBeNull()
  })

  it('does not repeat immediately after withdrawing', () => {
    const peek = petBits().find((bit) => bit.id === 'peek')
    if (!peek) throw new Error('missing peek behavior')
    expect(pickBit([peek], context(), remember(freshMemory(), 'peek', 90_000))).toBeNull()
    expect(pickBit([peek], context(), remember(freshMemory(), 'peek', 1000))?.id).toBe('peek')
  })
})
