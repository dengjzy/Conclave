import { distance, inside, type Rect, type Spot } from './pet-path'

type FlightPoint = { at: Spot; offset: number }
export type PetFlight = { points: FlightPoint[]; duration: number }
type FlightNode = { point: Spot; cost: number; previous: FlightNode | null; visited: boolean }
const blockedAt = (point: Spot, r: Rect) => point.x > r.left + .01 && point.x < r.right - .01 && point.y > r.top + .01 && point.y < r.bottom - .01

function crossesRect(from: Spot, to: Spot, rect: Rect): boolean {
  let enter = 0, leave = 1
  for (const [start, delta, lo, hi] of [
    [from.x, to.x - from.x, rect.left + .01, rect.right - .01],
    [from.y, to.y - from.y, rect.top + .01, rect.bottom - .01]
  ] as const) {
    if (Math.abs(delta) < .001) { if (start < lo || start > hi) return false; continue }
    const a = (lo - start) / delta, b = (hi - start) / delta
    enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b))
    if (enter > leave) return false
  }
  return true
}

function arc(from: Spot, to: Spot, size: number, bounds: Rect, avoid: readonly Rect[]): Spot[] {
  const steps = Math.max(12, Math.ceil(distance(from, to) / 10))
  const lift = Math.min(size * .8, Math.max(size * .16, distance(from, to) * .2))
  for (const height of [lift, lift * .6, lift * .3, 0]) {
    const points = Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t - height * 4 * t * (1 - t) }
    })
    const escaped = new Set(avoid.filter((r) => !blockedAt(from, r)))
    let entered = inside(from, bounds)
    const clear = points.every((point, i) => {
      if (i === 0) return true
      const previous = points[i - 1] ?? from
      if (inside(point, bounds)) entered = true
      else if (entered) return false
      return avoid.every((r) => {
        // A new input or panel may already cover the starting point: allow leaving it once.
        if (!escaped.has(r)) { if (!blockedAt(point, r)) escaped.add(r); return true }
        return !crossesRect(previous, point, r)
      })
    })
    if (clear) return points
  }
  return []
}

export function planFlight(from: Spot, to: Spot, avoid: readonly Rect[], bounds: Rect, size: number): PetFlight | null {
  if (!inside(to, bounds) || avoid.some((r) => blockedAt(to, r))) return null
  if (distance(from, to) < 1) return { points: [{ at: from, offset: 0 }, { at: to, offset: 1 }], duration: 0 }
  const start: FlightNode = { point: from, cost: 0, previous: null, visited: false }
  const destination: FlightNode = { point: to, cost: Infinity, previous: null, visited: false }
  const nodes = [start, destination]
  for (const r of [bounds, ...avoid]) {
    for (const x of [r.left - 1, r.right + 1]) for (const y of [r.top - 1, r.bottom + 1]) {
      const point = { x: Math.max(bounds.left, Math.min(bounds.right, x)), y: Math.max(bounds.top, Math.min(bounds.bottom, y)) }
      if (!avoid.some((other) => blockedAt(point, other))) nodes.push({ point, cost: Infinity, previous: null, visited: false })
    }
  }
  while (!destination.visited) {
    let current: FlightNode | null = null
    for (const node of nodes) if (!node.visited && Number.isFinite(node.cost) && (!current || node.cost < current.cost)) current = node
    if (!current) return null
    if (current === destination) break
    current.visited = true
    const departure = current.point
    for (const next of nodes) {
      if (next.visited || next === current) continue
      if (avoid.some((r) => !(current === start && blockedAt(from, r)) && crossesRect(departure, next.point, r))) continue
      const cost = current.cost + distance(departure, next.point)
      if (cost < next.cost) { next.cost = cost; next.previous = current }
    }
  }
  const route = [to]
  for (let at = destination.previous; at; at = at.previous) route.unshift(at.point)
  const points: FlightPoint[] = []
  let passed = 0, length = 0
  for (let i = 1; i < route.length; i++) {
    const departure = route[i - 1] ?? from, arrival = route[i] ?? to, segment = distance(departure, arrival)
    const curve = arc(departure, arrival, size, bounds, avoid)
    if (!curve.length) return null
    for (const [j, at] of curve.entries()) {
      if (j === 0 && points.length) continue
      const last = points.at(-1)
      if (last) length += distance(last.at, at)
      points.push({ at, offset: Math.min(1, Math.max(0, (passed + segment * j / (curve.length - 1)) / destination.cost)) })
    }
    passed += segment
  }
  return { points, duration: Math.min(1600, Math.max(320, length / (size * 4.8) * 1000)) }
}
