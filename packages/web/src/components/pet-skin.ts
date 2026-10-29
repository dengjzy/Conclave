import type { ReactNode } from 'react'
import type { PetHead } from '../pet-peek'
import type { Spot } from '../pet-path'

// What the pet can be doing, in the words Codex pets use (hatch-pet's animation rows) plus what a
// roaming pet adds: a nap, a seat on a ledge, being picked up, a head poked out from behind an
// edge, a sprint. Locomotion is not a pose: the stage says whether it walks and which way it faces.
export type PetPose =
  | 'idle' | 'running' | 'waiting' | 'review' | 'failed'
  | 'waving' | 'jumping'
  | 'nap' | 'sit' | 'hang' | 'peek' | 'sprint'

// The poses that play once and give way to whatever the pet was doing.
export const ONE_SHOT_POSES: ReadonlySet<PetPose> = new Set<PetPose>(['waving', 'jumping'])

export type PetSkinProps = {
  pose: PetPose
  walking: boolean
  // Where it looks, in its own frame: x toward where it faces, y up; each -1..1, 0 straight ahead.
  lookX: number
  lookY: number
  // The system asked for less motion: hold a still frame of the pose.
  reduced: boolean
}

// A look for the pet: the built-in ant now, a Codex-format spritesheet later. Drawn facing right
// with its feet on the bottom edge of a width × height box; the stage flips and places it.
export type PetSkin = {
  id: string
  width: number
  height: number
  head?: PetHead
  gazeOrigin?: Spot
  render(props: PetSkinProps): ReactNode
}
