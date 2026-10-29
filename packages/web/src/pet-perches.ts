import { center, crosses, distance, inside, type Rect, type Spot } from './pet-path'

// The lines of the interface are the pet's world: the top edge of a panel or a card is a ledge
// to walk along or sit on, the border between two panels a wall to climb or cling to, the edge
// of the stage the way in and out. Anything marked data-pet-perch="ledge|wall" offers its edge.

export type PerchKind = 'ledge' | 'wall' | 'edge'
export type Perch = {
  id: string
  kind: PerchKind
  from: Spot
  to: Spot
  // For a wall: which way the open screen lies, +1 right, -1 left. For a ledge: 0.
  inward: number
}

export type PerchSource = { id: string; kind: 'ledge' | 'wall' | 'divider'; rect: Rect }

const MIN_LEDGE = 48
const MIN_WALL = 64
const INSET = 10

// A point along a perch, t from 0 to 1.
export const pointOn = (perch: Perch, t: number): Spot => ({
  x: perch.from.x + (perch.to.x - perch.from.x) * t,
  y: perch.from.y + (perch.to.y - perch.from.y) * t
})

export const perchLength = (perch: Perch): number => distance(perch.from, perch.to)

const within = (spot: Spot, stage: Rect) => inside(spot, stage)

export function perchesOf(sources: readonly PerchSource[], stage: Rect, avoid: readonly Rect[] = []): Perch[] {
  const perches: Perch[] = []
  const stageMiddle = center(stage).x
  for (const { id, kind, rect } of sources) {
    if (kind === 'ledge') {
      const from = { x: Math.max(rect.left + INSET, stage.left + INSET), y: rect.top }
      const to = { x: Math.min(rect.right - INSET, stage.right - INSET), y: rect.top }
      if (to.x - from.x < MIN_LEDGE || !within(from, stage) || !within(to, stage)) continue
      if (avoid.some((other) => inside(from, other) || inside(to, other) || crosses(from, to, other))) continue
      perches.push({ id, kind, from, to, inward: 0 })
    } else {
      // The edge facing the middle of the stage: a sidebar offers its right side, a right panel its left.
      const x = kind === 'divider' ? center(rect).x : center(rect).x < stageMiddle ? rect.right : rect.left
      const inward = kind === 'divider' ? x < stageMiddle ? 1 : -1 : x === rect.right ? 1 : -1
      const from = { x, y: Math.max(rect.top + INSET, stage.top + INSET) }
      const to = { x, y: Math.min(rect.bottom - INSET, stage.bottom - INSET) }
      if (to.y - from.y < MIN_WALL || !within(from, stage) || !within(to, stage)) continue
      if (avoid.some((other) => inside(from, other) || inside(to, other) || crosses(from, to, other))) continue
      perches.push({ id, kind: 'wall', from, to, inward })
    }
  }
  // The stage's own bottom and sides, always there.
  perches.push({ id: 'edge:bottom', kind: 'edge', from: { x: stage.left + INSET, y: stage.bottom }, to: { x: stage.right - INSET, y: stage.bottom }, inward: 0 })
  perches.push({ id: 'edge:left', kind: 'edge', from: { x: stage.left, y: stage.top + INSET }, to: { x: stage.left, y: stage.bottom - INSET }, inward: 1 })
  perches.push({ id: 'edge:right', kind: 'edge', from: { x: stage.right, y: stage.top + INSET }, to: { x: stage.right, y: stage.bottom - INSET }, inward: -1 })
  return perches
}

export const isLedge = (perch: Perch): boolean => perch.kind === 'ledge' || (perch.kind === 'edge' && perch.from.y === perch.to.y)
export const isWall = (perch: Perch): boolean => perch.kind === 'wall' || (perch.kind === 'edge' && perch.from.x === perch.to.x)

export function supportingWall(perches: readonly Perch[], spot: Spot, inward: number, tolerance = 2): Perch | null {
  return perches.find((perch) =>
    isWall(perch) &&
    perch.inward === inward &&
    Math.abs(perch.from.x - spot.x) <= tolerance &&
    spot.y >= Math.min(perch.from.y, perch.to.y) - tolerance &&
    spot.y <= Math.max(perch.from.y, perch.to.y) + tolerance
  ) ?? null
}

// Which perch to go to next: near ones more than far, ones not lately visited more than those,
// with enough chance in it that two days never look the same.
export function pickPerch(perches: readonly Perch[], at: Spot, visited: ReadonlyMap<string, number>, now: number, random: () => number, want: 'ledge' | 'wall' | 'any' = 'any'): Perch | null {
  const candidates = perches.filter((perch) => perch.kind !== 'edge' && (want === 'any' || (want === 'ledge' ? isLedge(perch) : isWall(perch))))
  let total = 0
  const weighted = candidates.map((perch) => {
    const near = Math.min(distance(at, perch.from), distance(at, perch.to))
    const lately = visited.get(perch.id)
    const recency = lately === undefined ? 1 : now - lately < 60_000 ? 0.15 : now - lately < 300_000 ? 0.5 : 1
    const weight = (1 / (1 + near / 400)) * recency * (0.5 + random() * 0.5)
    total += weight
    return { perch, weight }
  })
  if (total === 0) return null
  let pick = random() * total
  for (const { perch, weight } of weighted) {
    pick -= weight
    if (pick <= 0) return perch
  }
  return weighted.at(-1)?.perch ?? null
}

// The nearest ledge under a point, for something dropped; the stage's bottom when none.
export function ledgeBelow(perches: readonly Perch[], spot: Spot): Perch {
  let best: Perch | null = null
  for (const perch of perches) {
    if (!isLedge(perch) || perch.from.y < spot.y - 1) continue
    if (spot.x < perch.from.x || spot.x > perch.to.x) continue
    if (!best || perch.from.y < best.from.y) best = perch
  }
  return best ?? perches.find((perch) => perch.id === 'edge:bottom') ?? { id: 'edge:bottom', kind: 'edge', from: spot, to: spot, inward: 0 }
}
