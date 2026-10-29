import { describe, expect, it } from 'vitest'
import { crosses, planPath, spotOutside, standingSpot } from './pet-path'

const stage = { left: 0, top: 0, right: 1000, bottom: 600 }

describe('planPath', () => {
  it('does not walk through the air or extend a short wall beyond its real ends', () => {
    const from = { x: 200, y: 500 }, to = { x: 200, y: 100 }
    expect(planPath(from, to, [], { supports: [{ from: { x: 200, y: 200 }, to: { x: 200, y: 400 } }] })).toEqual([{ kind: 'hop', to }])
    expect(planPath(from, to, [], { supports: [{ from: { x: 200, y: 50 }, to: { x: 200, y: 550 } }] })).toEqual([{ kind: 'climb', to }])
    expect(planPath({ x: 200, y: 100 }, { x: 500, y: 100 }, [], { supports: [] })).toEqual([{ kind: 'hop', to: { x: 500, y: 100 } }])
  })
  it('walks straight along a level', () => {
    expect(planPath({ x: 10, y: 600 }, { x: 300, y: 600 }, [])).toEqual([{ kind: 'walk', to: { x: 300, y: 600 } }])
  })

  it('goes across and then up when no wall is near', () => {
    expect(planPath({ x: 10, y: 600 }, { x: 300, y: 200 }, [])).toEqual([
      { kind: 'walk', to: { x: 300, y: 600 } },
      { kind: 'climb', to: { x: 300, y: 200 } }
    ])
  })

  it('climbs a wall on the way rather than thin air', () => {
    expect(planPath({ x: 10, y: 600 }, { x: 300, y: 200 }, [], { walls: [240] })).toEqual([
      { kind: 'walk', to: { x: 240, y: 600 } },
      { kind: 'climb', to: { x: 240, y: 200 } },
      { kind: 'walk', to: { x: 300, y: 200 } }
    ])
  })

  it('leaves a wall alone when it would be a long way round', () => {
    const legs = planPath({ x: 10, y: 600 }, { x: 300, y: 200 }, [], { walls: [900] })
    expect(legs.map((leg) => leg.kind)).toEqual(['walk', 'climb'])
  })

  it('hops over what it must not cross', () => {
    const box = { left: 100, top: 500, right: 200, bottom: 600 }
    expect(planPath({ x: 10, y: 550 }, { x: 300, y: 550 }, [box])).toEqual([{ kind: 'hop', to: { x: 300, y: 550 } }])
  })

  it('takes the other way round a box when one is clear', () => {
    const box = { left: 100, top: 500, right: 200, bottom: 650 }
    expect(planPath({ x: 10, y: 600 }, { x: 300, y: 200 }, [box])).toEqual([
      { kind: 'climb', to: { x: 10, y: 200 } },
      { kind: 'walk', to: { x: 300, y: 200 } }
    ])
  })

  it('hops when the trip would take too long', () => {
    expect(planPath({ x: 0, y: 600 }, { x: 3000, y: 600 }, [], { speed: 70, maxMs: 15_000 })).toEqual([{ kind: 'hop', to: { x: 3000, y: 600 } }])
  })

  it('stays put for no distance', () => {
    expect(planPath({ x: 5, y: 5 }, { x: 5.5, y: 5 }, [])).toEqual([])
  })
})

describe('crosses', () => {
  it('counts passing through, not standing on the top edge', () => {
    const box = { left: 100, top: 500, right: 200, bottom: 600 }
    expect(crosses({ x: 0, y: 550 }, { x: 300, y: 550 }, box)).toBe(true)
    expect(crosses({ x: 0, y: 500 }, { x: 300, y: 500 }, box)).toBe(false)
  })
})

describe('standingSpot', () => {
  it('stands on the top edge near the middle', () => {
    expect(standingSpot({ left: 100, top: 300, right: 300, bottom: 400 }, stage, 40)).toEqual({ x: 200, y: 300 })
  })

  it('keeps within the stage for an anchor at its edge', () => {
    expect(standingSpot({ left: 990, top: 300, right: 1100, bottom: 400 }, stage, 40)).toEqual({ x: 980, y: 300 })
    expect(standingSpot({ left: -50, top: -20, right: 10, bottom: 40 }, stage, 40)).toEqual({ x: 20, y: 1 })
  })
})

describe('spotOutside', () => {
  it('steps out by the nearest side', () => {
    const box = { left: 100, top: 100, right: 300, bottom: 200 }
    expect(spotOutside({ x: 110, y: 150 }, box, 8)).toEqual({ x: 92, y: 150 })
    expect(spotOutside({ x: 200, y: 190 }, box, 8)).toEqual({ x: 200, y: 208 })
  })
})
