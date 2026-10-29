import { between, mayRoam, type Bit, type Context } from './pet-brain'
import { center, distance, type Spot } from './pet-path'
import { isLedge, isWall, pickPerch, pointOn, type Perch } from './pet-perches'
import type { StageApi } from './pet-stage-api'

// The pet's repertoire. Each bit is a few lines of script against the stage; it can be cut short
// at any await, and leaves whatever it was doing where it was. Add one here and the picker knows it.

export type PetBit = Bit<StageApi>

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi)
const towards = (from: Spot, to: Spot): 1 | -1 => (to.x >= from.x ? 1 : -1)
// Where to look to see a point, in the pet's own frame.
const lookAt = (api: StageApi, target: Spot): void => {
  const at = api.spot()
  const dx = target.x - at.x
  const dy = at.y - 20 - target.y
  api.look(clamp(dx / 120, -1, 1) * api.facing(), clamp(dy / 120, -1, 1))
}
const glance = async (api: StageApi, c: Context, times: number) => {
  for (let i = 0; i < times; i++) {
    api.look(between(c.random, -1, 1), between(c.random, -0.4, 0.8))
    await api.wait(between(c.random, 500, 1300))
  }
  api.look(0, 0)
}
const restOnWall = async (api: StageApi, c: Context, duration: number) => {
  // The raised-arm hang frame is for being picked up; keep the feet on the wall at rest.
  api.pose(c.mood)
  for (const x of [-.65, .65, 0]) {
    api.look(x, between(c.random, -.2, .4))
    await api.wait(duration / 3)
  }
  api.look(0, 0)
}
const facingInward = async (api: StageApi) => {
  const inward = towards(api.spot(), center(api.bounds()))
  if (api.facing() !== inward) await api.face(inward)
}
const onto = (perch: Perch): { kind: 'floor' } | { kind: 'wall'; inward: number } => (isWall(perch) ? { kind: 'wall', inward: perch.inward } : { kind: 'floor' })

const sideOf = (api: StageApi, perch: Perch, t: number): Spot => {
  const spot = pointOn(perch, t)
  // On a wall the feet are on the line; a ledge's point is already on top of it.
  return spot
}

export function petBits(): PetBit[] {
  // Where it has been lately, so it goes somewhere else next.
  const visited = new Map<string, number>()

  const lookAround: PetBit = {
    id: 'look-around',
    cooldownMs: 8_000,
    score: (c) => (c.mood === 'idle' ? 1 : 0.3),
    run: async (api, c) => {
      await glance(api, c, Math.round(between(c.random, 2, 4)))
    }
  }

  const groom: PetBit = {
    id: 'groom',
    cooldownMs: 40_000,
    score: (c) => (c.mood === 'idle' && c.on !== 'wall' ? 0.6 : 0),
    run: async (api, c) => {
      api.pose('review')
      await api.wait(between(c.random, 1_500, 3_000))
      api.pose('idle')
    }
  }

  const stroll: PetBit = {
    id: 'stroll',
    weight: { quiet: 0, lively: 1.5 },
    cooldownMs: 10_000,
    score: (c) => (mayRoam(c) ? 1 : 0),
    run: async (api, c) => {
      const at = api.spot()
      const bounds = api.bounds()
      api.pose('idle')
      if (c.on === 'wall') {
        const dy = between(c.random, 40, 120) * (c.random() < 0.5 ? -1 : 1)
        await api.walkTo({ x: at.x, y: clamp(at.y + dy, bounds.top + 20, bounds.bottom) }, { onto: api.surface() })
      } else {
        const dx = between(c.random, 60, 220) * (c.random() < 0.5 ? -1 : 1)
        await api.walkTo({ x: clamp(at.x + dx, bounds.left + 20, bounds.right - 20), y: at.y })
      }
      await glance(api, c, 1)
    }
  }

  const relocate: PetBit = {
    id: 'relocate',
    weight: { quiet: 0.3, lively: 1.3 },
    cooldownMs: 20_000,
    score: (c) => (mayRoam(c) ? 0.9 : 0),
    run: async (api, c) => {
      const perch = pickPerch(api.perches(), api.spot(), visited, c.now, c.random)
      if (!perch) return
      visited.set(perch.id, c.now)
      api.pose('idle')
      await api.walkTo(sideOf(api, perch, between(c.random, 0.2, 0.8)), { onto: onto(perch) })
      if (isLedge(perch)) {
        await facingInward(api)
        api.pose('sit')
        await api.wait(between(c.random, 6_000, 18_000))
        await glance(api, c, 1)
      } else {
        await restOnWall(api, c, between(c.random, 4_000, 12_000))
      }
    }
  }

  const sit: PetBit = {
    id: 'sit',
    cooldownMs: 30_000,
    score: (c) => (c.mood === 'idle' && c.on !== 'wall' ? 1 : 0),
    run: async (api, c) => {
      await facingInward(api)
      api.pose('sit')
      await api.wait(between(c.random, 4_000, 9_000))
      await glance(api, c, 1)
      await api.wait(between(c.random, 4_000, 9_000))
    }
  }

  const nap: PetBit = {
    id: 'nap',
    weight: { quiet: 3, lively: 0.5 },
    cooldownMs: 60_000,
    score: (c) => (c.mood === 'idle' && c.on !== 'wall' ? (c.idleFor > 60_000 ? 2 : 0.6) : 0),
    run: async (api, c) => {
      await facingInward(api)
      api.pose('sit')
      await api.wait(between(c.random, 1_500, 3_000))
      api.pose('nap')
      await api.wait(c.level === 'quiet' ? between(c.random, 40_000, 120_000) : between(c.random, 20_000, 60_000))
      api.pose('idle')
      await glance(api, c, 1)
    }
  }

  const hang: PetBit = {
    id: 'hang',
    cooldownMs: 30_000,
    score: (c) => (c.mood === 'idle' && c.on === 'wall' ? 0.8 : 0),
    run: async (api, c) => {
      await restOnWall(api, c, between(c.random, 5_000, 12_000))
    }
  }

  const climbAbout: PetBit = {
    id: 'climb-about',
    weight: { quiet: 0 },
    cooldownMs: 15_000,
    score: (c) => (mayRoam(c) && c.on === 'wall' ? 0.5 : 0),
    run: async (api, c) => {
      const at = api.spot()
      const bounds = api.bounds()
      const up = { x: at.x, y: clamp(at.y - between(c.random, 60, 160), bounds.top + 20, bounds.bottom) }
      api.pose('idle')
      await api.walkTo(up, { onto: api.surface() })
      await glance(api, c, 1)
      await api.walkTo(at, { onto: api.surface() })
    }
  }

  // Behind an edge, only the head out, a look left and right, then back or all the way out.
  const peek: PetBit = {
    id: 'peek',
    weight: { quiet: 0, lively: 1.5 },
    cooldownMs: 75_000,
    score: (c) => (mayRoam(c) && c.mood === 'idle' && c.idleFor > 3_000 ? 0.8 : 0),
    run: async (api, c) => {
      const walls = api.perches().filter((perch) => perch.kind === 'wall')
      const wall = walls[Math.floor(c.random() * walls.length)]
      if (!wall) return
      await api.peekFrom(wall)
    }
  }

  const chase: PetBit = {
    id: 'chase-pointer',
    weight: { quiet: 0, lively: 1.5 },
    cooldownMs: 12_000,
    score: (c) => (mayRoam(c) && c.pointer && c.pointerDistance !== null && c.pointerDistance > 90 && c.pointerDistance < 420 && c.idleFor < 3_000 && c.on !== 'wall' ? 1.2 : 0),
    run: async (api, c) => {
      const pointer = api.pointer()
      if (!pointer) return
      const at = api.spot()
      const direction = towards(at, pointer)
      api.pose('idle')
      await api.walkTo({ x: clamp(pointer.x - direction * 60, api.bounds().left + 20, api.bounds().right - 20), y: at.y }, { sprint: true })
      const now = api.pointer({ nearby: true })
      if (now) lookAt(api, now)
      await api.wait(between(c.random, 1_000, 2_200))
      api.look(0, 0)
    }
  }

  const flee: PetBit = {
    id: 'flee',
    cooldownMs: 0,
    score: (c) => (c.urge === 'flee' ? 100 : 0),
    run: async (api, c) => {
      const pointer = api.pointer()
      const at = api.spot()
      const bounds = api.bounds()
      const away: 1 | -1 = pointer ? (pointer.x > at.x ? -1 : 1) : 1
      let x = clamp(at.x + away * between(c.random, 110, 170), bounds.left + 20, bounds.right - 20)
      if (Math.abs(x - at.x) < 40) x = clamp(at.x - away * 140, bounds.left + 20, bounds.right - 20)
      api.pose('idle')
      await api.walkTo({ x, y: at.y }, { sprint: true, onto: api.surface() })
      await api.face(away === 1 ? -1 : 1)
      const now = api.pointer({ nearby: true })
      if (now) lookAt(api, now)
      await api.wait(900)
      api.look(0, 0)
    }
  }

  const greet: PetBit = {
    id: 'greet',
    cooldownMs: 0,
    score: (c) => (c.urge === 'greet' ? 100 : 0),
    run: async (api, c) => {
      const pointer = api.pointer({ nearby: true })
      if (pointer) lookAt(api, pointer)
      await api.once(c.random() < 0.5 ? 'jumping' : 'waving')
      api.look(0, 0)
    }
  }

  // Out of something it must not be on.
  const yieldWay: PetBit = {
    id: 'yield',
    cooldownMs: 0,
    score: (c) => (c.urge === 'yield' ? 100 : 0),
    run: async (api) => {
      api.clip(null)
      await api.hopTo(api.home())
    }
  }

  // The agents are up to something: hold the pose that says so.
  const hold: PetBit = {
    id: 'hold',
    cooldownMs: 0,
    score: (c) => (c.mood !== 'idle' ? 5 : !mayRoam(c) ? 1 : 0.05),
    run: async (api, c) => {
      api.pose(c.mood === 'idle' ? 'idle' : c.mood)
      if (c.mood === 'waiting' && c.random() < 0.4) {
        const pointer = api.pointer({ nearby: true })
        if (pointer) lookAt(api, pointer)
      }
      await api.wait(between(c.random, 2_000, 4_000))
      api.look(0, 0)
    }
  }

  const speak: PetBit = {
    id: 'speak',
    cooldownMs: 0,
    score: (c) => (c.message ? 60 : 0),
    run: async (api, c) => {
      const message = c.message
      if (!message) return
      const anchor = message.anchor()
      api.clip(null)
      if (anchor) {
        const spot = api.standingSpot(anchor)
        const far = distance(api.spot(), spot) > 300
        api.pose('idle')
        await api.walkTo(spot, { sprint: far })
        const toward = towards(api.spot(), center(anchor))
        if (api.facing() !== toward && Math.abs(center(anchor).x - api.spot().x) > 24) await api.face(toward)
        lookAt(api, center(anchor))
        await api.wait(500)
      }
      api.pose(c.mood === 'idle' ? 'waiting' : c.mood)
      await api.say(message)
      api.look(0, 0)
      api.pose(c.mood === 'idle' ? 'idle' : c.mood)
    }
  }

  return [speak, yieldWay, flee, greet, hold, lookAround, groom, stroll, relocate, sit, nap, hang, climbAbout, peek, chase]
}
