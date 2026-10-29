import type { Spot } from './pet-path'
import type { Say } from './pet-stage-api'

// How the pet decides what to do next. Not a state machine: a repertoire of bits, each saying how
// much it wants to happen now, and a draw weighted by that. What it did lately counts against it,
// so no two runs look alike, and the level the user picked changes the weights, not the list.

export type PetLevel = 'off' | 'quiet' | 'medium' | 'lively'
// What the agents are up to, reduced to what the pet shows with its body.
export type Mood = 'idle' | 'running' | 'waiting' | 'review' | 'failed'
// What the stage asks for ahead of anything else: to get away from a hovering pointer, to answer
// a click, to get out of something it must not cover.
export type Urge = 'flee' | 'greet' | 'yield' | null

export type Context = {
  now: number
  level: PetLevel
  mood: Mood
  reduced: boolean
  // Until when the user counts as typing.
  typingUntil: number
  // How long since the user last moved the pointer or pressed a key.
  idleFor: number
  pointer: Spot | null
  // How far the pointer is from the pet, null without a pointer.
  pointerDistance: number | null
  urge: Urge
  message: Say | null
  on: 'ledge' | 'wall' | 'floor'
  random(): number
}

export type Bit<Api> = {
  id: string
  // Scales the score per level; a missing level keeps 1, 0 drops the bit at that level.
  weight?: Partial<Record<PetLevel, number>>
  cooldownMs: number
  // How much it wants to happen now; 0 or less rules it out.
  score(c: Context): number
  run(api: Api, c: Context): Promise<void>
}

export type Memory = {
  last: string | null
  doneAt: ReadonlyMap<string, number>
  recent: readonly string[]
}

export const freshMemory = (): Memory => ({ last: null, doneAt: new Map(), recent: [] })

const RECENT = 3

export function pickBit<Api>(bits: readonly Bit<Api>[], c: Context, memory: Memory): Bit<Api> | null {
  for (const id of [c.urge === 'yield' ? 'yield' : null, c.message ? 'speak' : null, c.urge]) {
    const required = id && bits.find((bit) => bit.id === id && bit.score(c) > 0)
    if (required) return required
  }
  let total = 0
  const weighted: { bit: Bit<Api>; weight: number }[] = []
  for (const bit of bits) {
    const level = bit.weight?.[c.level] ?? 1
    if (level <= 0) continue
    const done = memory.doneAt.get(bit.id)
    if (done !== undefined && c.now - done < bit.cooldownMs) continue
    let weight = bit.score(c) * level
    if (weight <= 0) continue
    if (memory.last === bit.id) weight *= 0.1
    else if (memory.recent.includes(bit.id)) weight *= 0.5
    total += weight
    weighted.push({ bit, weight })
  }
  if (total === 0) return null
  let pick = c.random() * total
  for (const { bit, weight } of weighted) {
    pick -= weight
    if (pick <= 0) return bit
  }
  return weighted.at(-1)?.bit ?? null
}

export function remember(memory: Memory, id: string, now: number): Memory {
  const doneAt = new Map(memory.doneAt)
  doneAt.set(id, now)
  return { last: id, doneAt, recent: [id, ...memory.recent.filter((other) => other !== id)].slice(0, RECENT) }
}

// How long it sits still between bits: the levels are mostly this.
export function restMs(level: PetLevel, random: () => number): number {
  const [lo, hi] = level === 'lively' ? [2_000, 6_000] : level === 'medium' ? [6_000, 20_000] : [20_000, 60_000]
  return lo + random() * (hi - lo)
}

// Someone typing for the last while gets no company; nothing roams while the agents hold a pose.
export const mayRoam = (c: Context): boolean => (c.mood === 'idle' || c.mood === 'running') && c.now >= c.typingUntil && !c.reduced

export const between = (random: () => number, lo: number, hi: number): number => lo + random() * (hi - lo)
