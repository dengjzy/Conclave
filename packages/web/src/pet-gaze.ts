import type { Spot } from './pet-path'

type Frame = { a: number; b: number; c: number; d: number; e: number; f: number }

export function petPointerNear(pointer: Spot, center: Spot, width: number, following = false): boolean {
  const radius = Math.max(160, width * 2) * (following ? 1.2 : 1)
  return Math.hypot(pointer.x - center.x, pointer.y - center.y) <= radius
}

function localPointer(pointer: Spot, frame: Frame): Spot | null {
  const determinant = frame.a * frame.d - frame.b * frame.c
  if (Math.abs(determinant) < .001) return null
  const dx = pointer.x - frame.e, dy = pointer.y - frame.f
  return { x: (frame.d * dx - frame.c * dy) / determinant, y: (-frame.b * dx + frame.a * dy) / determinant }
}

// The walker rotates around its feet; undo that rotation before mirroring the gaze.
export function petPointerLook(pointer: Spot, frame: Frame, origin: Spot, width: number, height: number, facing: 1 | -1) {
  const local = localPointer(pointer, frame)
  if (!local) return { x: 0, y: 0 }
  const x = local.x * facing - (origin.x - width / 2)
  const y = local.y - (origin.y - height)
  const reach = Math.max(80, width * 1.35)
  return { x: Math.tanh(x / reach), y: Math.tanh(-y / reach) }
}

export function petPointerFacing(pointer: Spot, frame: Frame, width: number, facing: 1 | -1): 1 | -1 {
  const local = localPointer(pointer, frame)
  // Use the feet's centre, which stays put after a turn, with a gap between either threshold.
  if (!local || Math.abs(local.x) < width * .3) return facing
  return local.x > 0 ? 1 : -1
}
