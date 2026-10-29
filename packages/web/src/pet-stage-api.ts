import type { PetPose } from './components/pet-skin'
import type { Rect, Spot } from './pet-path'
import type { Perch } from './pet-perches'

// What the pet stands on, which decides which way is down for it.
export type Surface = { kind: 'floor' } | { kind: 'wall'; inward: number }

// Something to say, from whoever decides what the pet talks about: where to stand for it and
// what opens when the bubble is clicked.
export type Say = {
  key: string
  text: string
  anchor(): Rect | null
  open?: () => void
  // How long the bubble stays unless dismissed; null keeps it until the message goes away.
  holdMs: number | null
}

// Thrown out of every waiting call when the stage cuts a bit short: the layout moved, the user
// started typing, something more pressing came up. A bit lets it fly.
export class Interrupted extends Error {
  constructor() {
    super('interrupted')
  }
}

// The stage, as a bit sees it. Positions are in the stage's own pixels.
export type StageApi = {
  spot(): Spot
  facing(): 1 | -1
  surface(): Surface
  bounds(): Rect
  perches(): Perch[]
  home(): Spot
  pointer(options?: { nearby: boolean }): Spot | null
  random(): number
  // Where to stand to talk about something: on its top edge, kept within the stage.
  standingSpot(anchor: Rect): Spot
  pose(pose: PetPose): void
  look(x: number, y: number): void
  face(direction: 1 | -1): Promise<void>
  // Plans and takes the way there: walks, climbs, or hops where it must. `onto` is what the
  // destination is on; without it, the floor.
  walkTo(to: Spot, options?: { sprint?: boolean; onto?: Surface }): Promise<void>
  hopTo(to: Spot, onto?: Surface): Promise<void>
  // Hide behind a real divider, lean the head out, look about, then withdraw.
  peekFrom(wall: Perch): Promise<void>
  once(pose: 'waving' | 'jumping'): Promise<void>
  wait(ms: number): Promise<void>
  // Show only what falls inside the rectangle (a head poked out from behind an edge); null shows all.
  clip(rect: Rect | null): void
  // Put the bubble up and stay with it until it is dismissed, its time is up or it is gone.
  say(message: Say): Promise<void>
}
