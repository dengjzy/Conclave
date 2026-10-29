// Where the pet stands and how it gets somewhere else, in the stage's pixels: x, y is the point
// its feet touch. A trip is a horizontal walk and a vertical climb (ants take walls as they take
// floors); one that would cross something it must not cover, or take too long, is a hop instead:
// a continuous airborne jump or glide between the two surfaces.

export type Spot = { x: number; y: number }
export type Rect = { left: number; top: number; right: number; bottom: number }
export type Leg = { kind: 'walk' | 'climb' | 'hop'; to: Spot }

export const SPEED = 70
export const SPRINT = 3
export const MAX_WALK_MS = 15_000

export const distance = (a: Spot, b: Spot): number => Math.hypot(a.x - b.x, a.y - b.y)

export const inside = (spot: Spot, rect: Rect, pad = 0): boolean =>
  spot.x >= rect.left - pad && spot.x <= rect.right + pad && spot.y >= rect.top - pad && spot.y <= rect.bottom + pad

export const grow = (rect: Rect, by: number): Rect => ({ left: rect.left - by, top: rect.top - by, right: rect.right + by, bottom: rect.bottom + by })

export const center = (rect: Rect): Spot => ({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 })
export const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

// Whether an axis-aligned segment passes through a rectangle (touching its edge counts: the pet
// standing on a box's top edge is on it).
export function crosses(a: Spot, b: Spot, rect: Rect): boolean {
  const left = Math.min(a.x, b.x)
  const right = Math.max(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const bottom = Math.max(a.y, b.y)
  return right > rect.left && left < rect.right && bottom > rect.top && top < rect.bottom
}

const clean = (legs: readonly Leg[], from: Spot, avoid: readonly Rect[]): boolean => {
  let at = from
  for (const leg of legs) {
    if (avoid.some((rect) => crosses(at, leg.to, rect))) return false
    at = leg.to
  }
  return true
}

const length = (legs: readonly Leg[], from: Spot): number => {
  let at = from
  let total = 0
  for (const leg of legs) {
    total += distance(at, leg.to)
    at = leg.to
  }
  return total
}

// Across then up, or up then across, whichever stays clear; a hop when neither does or the way is
// long enough to bore. Given the walls about (their x), it climbs one of those rather than thin
// air when one is near enough: a detour of up to a third of the trip, or 160px, whichever is more.
export function planPath(from: Spot, to: Spot, avoid: readonly Rect[], options: { speed?: number; maxMs?: number; walls?: readonly number[]; supports?: readonly { from: Spot; to: Spot }[] } = {}): Leg[] {
  const speed = options.speed ?? SPEED
  const maxMs = options.maxMs ?? MAX_WALK_MS
  if (distance(from, to) < 1) return []
  const hop: Leg[] = [{ kind: 'hop', to }]
  const routes: Leg[][] = []
  if (from.y === to.y) routes.push([{ kind: 'walk', to }])
  else if (from.x === to.x) routes.push([{ kind: 'climb', to }])
  else {
    const direct = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
    const slack = Math.max(160, direct / 3)
    const walls = [...(options.walls ?? [])]
      .map((x) => ({ x, detour: Math.abs(x - from.x) + Math.abs(to.x - x) - Math.abs(to.x - from.x) }))
      .filter(({ detour }) => detour <= slack)
      .sort((a, b) => a.detour - b.detour)
    for (const { x } of walls) {
      const viaWall: Leg[] = [{ kind: 'walk', to: { x, y: from.y } }, { kind: 'climb', to: { x, y: to.y } }, { kind: 'walk', to }]
      // A leg that goes nowhere (already at the wall, or the wall is at the destination) is dropped.
      routes.push(viaWall.filter((leg, index) => distance(index === 0 ? from : viaWall[index - 1]?.to ?? from, leg.to) >= 1))
    }
    routes.push([{ kind: 'walk', to: { x: to.x, y: from.y } }, { kind: 'climb', to }])
    routes.push([{ kind: 'climb', to: { x: from.x, y: to.y } }, { kind: 'walk', to }])
  }
  for (const route of routes) {
    if (!clean(route, from, avoid)) continue
    let at = from
    const supported = route.every((leg) => {
      const start = at
      at = leg.to
      return !options.supports || options.supports.some((p) => leg.kind === 'walk'
        ? Math.abs(p.from.y - start.y) < 1 && Math.abs(p.to.y - start.y) < 1 && Math.min(start.x, leg.to.x) >= Math.min(p.from.x, p.to.x) - 12 && Math.max(start.x, leg.to.x) <= Math.max(p.from.x, p.to.x) + 12
        : Math.abs(p.from.x - start.x) < 1 && Math.abs(p.to.x - start.x) < 1 && Math.min(start.y, leg.to.y) >= Math.min(p.from.y, p.to.y) - 12 && Math.max(start.y, leg.to.y) <= Math.max(p.from.y, p.to.y) + 12)
    })
    if (!supported) continue
    if ((length(route, from) / speed) * 1000 > maxMs) return hop
    return route
  }
  return hop
}

// Where to stand to talk about something: on its top edge, near its middle, kept within the stage
// with the pet's own width.
export function standingSpot(anchor: Rect, stage: Rect, width: number): Spot {
  const half = width / 2
  const lo = Math.max(anchor.left + half, stage.left + half)
  const hi = Math.min(anchor.right - half, stage.right - half)
  const middle = (anchor.left + anchor.right) / 2
  const x = lo <= hi ? Math.min(Math.max(middle, lo), hi) : Math.min(Math.max(middle, stage.left + half), stage.right - half)
  const y = Math.min(Math.max(anchor.top, stage.top + 1), stage.bottom)
  return { x, y }
}

// The nearest point just outside a rectangle the pet finds itself in.
export function spotOutside(spot: Spot, rect: Rect, margin: number): Spot {
  const toLeft = spot.x - rect.left
  const toRight = rect.right - spot.x
  const toTop = spot.y - rect.top
  const toBottom = rect.bottom - spot.y
  const least = Math.min(toLeft, toRight, toTop, toBottom)
  if (least === toLeft) return { x: rect.left - margin, y: spot.y }
  if (least === toRight) return { x: rect.right + margin, y: spot.y }
  if (least === toTop) return { x: spot.x, y: rect.top - margin }
  return { x: spot.x, y: rect.bottom + margin }
}
