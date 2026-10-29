import { describe, expect, it } from 'vitest'
import { isLedge, isWall, ledgeBelow, perchesOf, pickPerch, supportingWall } from './pet-perches'

const stage = { left: 0, top: 0, right: 1000, bottom: 600 }

describe('perchesOf', () => {
  it('uses the visible centre of vertical separator hit areas', () => {
    const perches = perchesOf([
      { id: 'left', kind: 'divider', rect: { left: 234, right: 246, top: 0, bottom: 600 } },
      { id: 'right', kind: 'divider', rect: { left: 754, right: 766, top: 0, bottom: 600 } }
    ], stage)
    expect(perches.find((p) => p.id === 'left')).toMatchObject({ kind: 'wall', from: { x: 240 }, inward: 1 })
    expect(perches.find((p) => p.id === 'right')).toMatchObject({ kind: 'wall', from: { x: 760 }, inward: -1 })
  })
  it('rejects a ledge whose middle passes through a forbidden rectangle', () => {
    const perches = perchesOf([{ id: 'crossing', kind: 'ledge', rect: { left: 100, top: 200, right: 900, bottom: 300 } }], stage, [{ left: 400, top: 100, right: 600, bottom: 400 }])
    expect(perches.some((p) => p.id === 'crossing')).toBe(false)
  })
  it('offers a panel its top edge and a side panel its inner edge', () => {
    const perches = perchesOf([
      { id: 'card', kind: 'ledge', rect: { left: 300, top: 200, right: 700, bottom: 300 } },
      { id: 'sidebar', kind: 'wall', rect: { left: 0, top: 0, right: 220, bottom: 600 } },
      { id: 'panel', kind: 'wall', rect: { left: 800, top: 0, right: 1000, bottom: 600 } }
    ], stage)
    expect(perches.find((perch) => perch.id === 'card')).toEqual({ id: 'card', kind: 'ledge', from: { x: 310, y: 200 }, to: { x: 690, y: 200 }, inward: 0 })
    expect(perches.find((perch) => perch.id === 'sidebar')).toMatchObject({ kind: 'wall', from: { x: 220, y: 10 }, inward: 1 })
    expect(perches.find((perch) => perch.id === 'panel')).toMatchObject({ kind: 'wall', from: { x: 800, y: 10 }, inward: -1 })
  })

  it('drops what is too short, out of the stage or in the way of something', () => {
    const perches = perchesOf([
      { id: 'chip', kind: 'ledge', rect: { left: 300, top: 200, right: 340, bottom: 230 } },
      { id: 'offscreen', kind: 'ledge', rect: { left: 300, top: -40, right: 700, bottom: 10 } },
      { id: 'covered', kind: 'ledge', rect: { left: 300, top: 400, right: 700, bottom: 500 } }
    ], stage, [{ left: 280, top: 380, right: 720, bottom: 520 }])
    expect(perches.filter((perch) => perch.kind !== 'edge')).toEqual([])
  })

  it('always has the stage edges', () => {
    const perches = perchesOf([], stage)
    expect(perches.map((perch) => perch.id)).toEqual(['edge:bottom', 'edge:left', 'edge:right'])
    expect(perches.filter(isLedge)).toHaveLength(1)
    expect(perches.filter(isWall)).toHaveLength(2)
  })
})

describe('pickPerch', () => {
  const perches = perchesOf([
    { id: 'near', kind: 'ledge', rect: { left: 50, top: 500, right: 250, bottom: 560 } },
    { id: 'far', kind: 'ledge', rect: { left: 700, top: 100, right: 950, bottom: 160 } }
  ], stage)
  const at = { x: 60, y: 600 }

  it('leans to what is near', () => {
    let near = 0
    for (let i = 0; i < 200; i++) {
      const seed = (i * 7919) % 1000 / 1000
      if (pickPerch(perches, at, new Map(), 0, () => seed)?.id === 'near') near += 1
    }
    expect(near).toBeGreaterThan(120)
  })

  it('leans away from where it has just been', () => {
    let near = 0
    for (let i = 0; i < 200; i++) {
      const seed = (i * 7919) % 1000 / 1000
      if (pickPerch(perches, at, new Map([['near', 0]]), 10_000, () => seed)?.id === 'near') near += 1
    }
    expect(near).toBeLessThan(100)
  })

  it('never picks the stage edges and honours what kind is wanted', () => {
    expect(pickPerch(perchesOf([], stage), at, new Map(), 0, () => 0.5)).toBeNull()
    expect(pickPerch(perches, at, new Map(), 0, () => 0.5, 'wall')).toBeNull()
  })
})

describe('ledgeBelow', () => {
  it('finds the first ledge under a point, else the floor', () => {
    const perches = perchesOf([
      { id: 'upper', kind: 'ledge', rect: { left: 100, top: 100, right: 400, bottom: 160 } },
      { id: 'lower', kind: 'ledge', rect: { left: 100, top: 300, right: 400, bottom: 360 } }
    ], stage)
    expect(ledgeBelow(perches, { x: 200, y: 50 }).id).toBe('upper')
    expect(ledgeBelow(perches, { x: 200, y: 200 }).id).toBe('lower')
    expect(ledgeBelow(perches, { x: 600, y: 200 }).id).toBe('edge:bottom')
  })
})

describe('supportingWall', () => {
  const wall = { id: 'divider', kind: 'wall' as const, from: { x: 700, y: 10 }, to: { x: 700, y: 590 }, inward: -1 }

  it('finds a wall under a clinging pet', () => {
    expect(supportingWall([wall], { x: 700, y: 300 }, -1)).toBe(wall)
  })

  it('rejects a wall that moved, ends before the pet or faces the other way', () => {
    expect(supportingWall([{ ...wall, from: { x: 680, y: 10 }, to: { x: 680, y: 590 } }], { x: 700, y: 300 }, -1)).toBeNull()
    expect(supportingWall([wall], { x: 700, y: 700 }, -1)).toBeNull()
    expect(supportingWall([wall], { x: 700, y: 300 }, 1)).toBeNull()
  })
})
