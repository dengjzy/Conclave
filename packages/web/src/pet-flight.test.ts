import { describe, expect, it } from 'vitest'
import { planFlight, type PetFlight } from './pet-flight'
import { distance, inside, type Rect } from './pet-path'

const bounds = { left: 60, right: 940, top: 124, bottom: 696 }
function expectClear(flight: PetFlight | null, avoid: Rect[] = []) {
  expect(flight).not.toBeNull()
  if (!flight) return
  expect(flight.points[0]?.offset).toBe(0)
  expect(flight.points.at(-1)?.offset).toBeCloseTo(1)
  for (const [i, { at, offset }] of flight.points.entries()) {
    expect(offset).toBeGreaterThanOrEqual(0)
    expect(offset).toBeLessThanOrEqual(1)
    expect(inside(at, bounds)).toBe(true)
    const previous = flight.points[i - 1]
    if (!previous) continue
    expect(offset).toBeGreaterThanOrEqual(previous.offset)
    expect(distance(at, previous.at)).toBeLessThan(25)
    for (let t = 0; t <= 1; t += .1) {
      const point = { x: previous.at.x + (at.x - previous.at.x) * t, y: previous.at.y + (at.y - previous.at.y) * t }
      expect(avoid.some((r) => inside(point, r))).toBe(false)
    }
  }
}

describe('pet flight between disconnected surfaces', () => {
  it('connects the exact endpoints with a visible upward arc', () => {
    const from = { x: 180, y: 580 }, to = { x: 700, y: 400 }
    const flight = planFlight(from, to, [], bounds, 120)
    expectClear(flight)
    expect(flight?.points[0]?.at).toEqual(from)
    expect(flight?.points.at(-1)?.at).toEqual(to)
    expect(flight?.points.some(({ at, offset }) => at.y < from.y + (to.y - from.y) * offset - 30)).toBe(true)
  })

  it('glides around the expanded browser or input area rather than crossing it', () => {
    const avoid = [{ left: 350, right: 620, top: 300, bottom: 620 }]
    const flight = planFlight({ x: 180, y: 500 }, { x: 780, y: 500 }, avoid, bounds, 120)
    expectClear(flight, avoid)
    expect(flight?.points.some(({ at }) => at.y < 300 || at.y > 620)).toBe(true)
  })

  it('stays below the window top on a high ledge, reducing the arc when needed', () => {
    const flight = planFlight({ x: 180, y: 126 }, { x: 780, y: 126 }, [], bounds, 120)
    expectClear(flight)
  })

  it('produces valid animation offsets for fractional divider positions', () => {
    expectClear(planFlight({ x: 450, y: 660 }, { x: 368, y: 449.0625 }, [], bounds, 160))
  })

  it('refuses an unreachable destination instead of teleporting through a barrier', () => {
    const avoid = [{ left: 350, right: 620, top: 0, bottom: 800 }]
    expect(planFlight({ x: 180, y: 500 }, { x: 780, y: 500 }, avoid, bounds, 120)).toBeNull()
    expect(planFlight({ x: 180, y: 500 }, { x: 450, y: 500 }, avoid, bounds, 120)).toBeNull()
  })

  it('can land on an obstacle edge without treating that edge as permission to pass through it', () => {
    const box = { left: 350, right: 620, top: 300, bottom: 620 }
    for (const [from, to] of [
      [{ x: 180, y: 400 }, { x: 450, y: 300 }],
      [{ x: 450, y: 300 }, { x: 450, y: 660 }]
    ] as const) {
      const flight = planFlight(from, to, [box], bounds, 120)
      expect(flight).not.toBeNull()
      for (const { at } of flight?.points ?? []) expect(at.x > box.left && at.x < box.right && at.y > box.top && at.y < box.bottom).toBe(false)
    }
  })

  it('can leave a forbidden area that appeared under the pet without reentering it', () => {
    const box = { left: 150, right: 300, top: 400, bottom: 620 }, avoid = [box]
    const flight = planFlight({ x: 200, y: 500 }, { x: 780, y: 500 }, avoid, bounds, 120)
    expect(flight).not.toBeNull()
    let escaped = false
    for (const point of flight?.points ?? []) {
      if (!inside(point.at, box)) escaped = true
      if (escaped) expect(inside(point.at, box)).toBe(false)
    }
    expect(escaped).toBe(true)
  })

  it('keeps timing proportional to pet size and bounds the length of long flights', () => {
    const small = planFlight({ x: 100, y: 600 }, { x: 400, y: 600 }, [], bounds, 80)
    const large = planFlight({ x: 100, y: 600 }, { x: 700, y: 600 }, [], bounds, 160)
    expect(small?.duration).toBeCloseTo(large?.duration ?? 0, 0)
    expect(planFlight({ x: 60, y: 696 }, { x: 940, y: 124 }, [], bounds, 80)?.duration).toBeLessThanOrEqual(1600)
  })
})
