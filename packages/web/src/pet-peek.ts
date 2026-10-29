import { overlaps, type Rect, type Spot } from './pet-path'
import type { Perch } from './pet-perches'

export type PetHead = { bounds: Rect; neck: Spot }
export type PeekPlan = {
  wall: Perch
  facing: 1 | -1
  hidden: Spot
  shown: Spot
  clip: Rect
  head: Rect
}

export function visiblePeekHead(plan: PeekPlan, at: Spot): Rect | null {
  const r = {
    left: Math.max(at.x + plan.head.left, plan.clip.left),
    right: Math.min(at.x + plan.head.right, plan.clip.right),
    top: Math.max(at.y + plan.head.top, plan.clip.top),
    bottom: Math.min(at.y + plan.head.bottom, plan.clip.bottom)
  }
  return r.right > r.left && r.bottom > r.top ? r : null
}

export function planPeek(wall: Perch, head: PetHead, width: number, height: number, stage: Rect, avoid: readonly Rect[], at: number): PeekPlan | null {
  if (wall.kind !== 'wall' || wall.from.x !== wall.to.x || !wall.inward) return null
  const facing = wall.inward > 0 ? 1 : -1
  const edge = wall.from.x, pad = Math.max(4, width * .08)
  const localHead = {
    left: (facing > 0 ? head.bounds.left - width / 2 : width / 2 - head.bounds.right) - pad,
    right: (facing > 0 ? head.bounds.right - width / 2 : width / 2 - head.bounds.left) + pad,
    top: head.bounds.top - height - pad,
    bottom: head.bounds.bottom - height + pad
  }
  const lo = Math.max(stage.top + height + 4, wall.from.y + 8 - localHead.top)
  const hi = Math.min(stage.bottom - 8, wall.to.y - 8 - localHead.bottom)
  if (lo > hi) return null
  const clip = { left: facing > 0 ? edge : stage.left, right: facing > 0 ? stage.right : edge, top: wall.from.y, bottom: wall.to.y }
  const hiddenX = edge - (facing > 0 ? localHead.right + 2 : localHead.left - 2)
  const shownX = edge - facing * (head.neck.x - width / 2)
  for (const t of [Math.min(1, Math.max(0, at)), .25, .5, .75]) {
    const y = lo + (hi - lo) * t
    const plan: PeekPlan = { wall, facing, hidden: { x: hiddenX, y }, shown: { x: shownX, y }, clip, head: localHead }
    const visible = visiblePeekHead(plan, plan.shown)
    if (!visible || visible.left < stage.left + 4 || visible.right > stage.right - 4) continue
    if (!avoid.some((rect) => overlaps(visible, rect))) return plan
  }
  return null
}
