import { SPEED, SPRINT } from './pet-path'

const REFERENCE_SIZE = 120
const STRIDE = .42

// A complete left/right step pair covers the same fraction of the sprite at every size.
export function petGait(size: number, sprint = false) {
  const speed = SPEED * size / REFERENCE_SIZE * (sprint ? SPRINT : 1)
  return { speed, cycleMs: size * STRIDE / speed * 1000 }
}
