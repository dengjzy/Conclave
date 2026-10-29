import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useBackgroundRest } from '../background-rest'
import { t } from '../i18n'
import { petBits, type PetBit } from '../pet-bits'
import { freshMemory, pickBit, remember, restMs, type Context, type Mood, type PetLevel, type Urge } from '../pet-brain'
import { petGait } from '../pet-gait'
import { planFlight } from '../pet-flight'
import { petPointerFacing, petPointerLook, petPointerNear } from '../pet-gaze'
import { distance, overlaps, planPath, standingSpot, type Rect, type Spot } from '../pet-path'
import { isLedge, isWall, ledgeBelow, perchesOf, supportingWall, type Perch, type PerchSource } from '../pet-perches'
import { planPeek, visiblePeekHead, type PeekPlan } from '../pet-peek'
import { Interrupted, type Say, type StageApi, type Surface } from '../pet-stage-api'
import { avoidRects, hideReason } from '../pet-yield'
import { ONE_SHOT_POSES, type PetPose, type PetSkin } from './pet-skin'
import './pet-stage.css'
import { PetSpeech } from './PetSpeech'

export type PetStageHandle = {
  play(bitId: string): void
  pose(pose: PetPose): void
  interrupt(): void
  bits(): string[]
}
type Bubble = { message: Say; at: Spot; below: boolean; close(): void }
type Waiter = { timer: ReturnType<typeof setTimeout> | null; reject(error: Error): void }
type Relocation = { to: Spot; kind: 'hop' | 'fall' }
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi))
const rotation = (surface: Surface) => surface.kind === 'wall' ? surface.inward > 0 ? 90 : -90 : 0

export function PetStage({ skin, level, mood, message = null, reduced = false, home = null, ref }: {
  skin: PetSkin
  level: PetLevel
  mood: Mood
  message?: Say | null
  reduced?: boolean
  home?: ((bounds: Rect) => Spot) | null
  ref?: Ref<PetStageHandle>
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const walkerRef = useRef<HTMLDivElement>(null)
  const facingRef = useRef<HTMLDivElement>(null)
  const turnRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const commands = useRef<PetStageHandle | null>(null)
  const position = useRef<Spot | null>(null)
  const latest = useRef({ mood, message, home })
  latest.current = { mood, message, home }
  const [pose, setPose] = useState<PetPose>(mood)
  const [walking, setWalking] = useState(false)
  const [look, setLook] = useState({ x: 0, y: 0 })
  const [clip, setClip] = useState<Rect | null>(null)
  const [hidden, setHidden] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const consumed = useRef(new Set<string>())

  useImperativeHandle(ref, () => ({
    play: (id) => commands.current?.play(id),
    pose: (next) => commands.current?.pose(next),
    interrupt: () => commands.current?.interrupt(),
    bits: () => commands.current?.bits() ?? []
  }), [])

  useEffect(() => {
    const stage = stageRef.current
    const walker = walkerRef.current
    const facing = facingRef.current
    const turnLayer = turnRef.current
    if (!stage || !walker || !facing || !turnLayer || level === 'off') return
    let alive = true
    let gen = 0
    let face: 1 | -1 = 1
    let surface: Surface = { kind: 'floor' }
    const currentSurface = (): Surface => surface
    let currentPose: PetPose = latest.current.mood
    let pos: Spot = { x: skin.width, y: stage.clientHeight }
    let pointer: Spot | null = null
    let activityAt = Date.now()
    let typingUntil = 0
    let hoverSince = 0
    let draggingNow = false
    let still = false
    let urge: Urge = null
    let forced: PetBit | null = null
    let saying: { message: Say; finish(consume: boolean): void } | null = null
    let releaseDrag: (() => void) | null = null
    let peeking: { plan: PeekPlan; approach: Spot; returnTo: Spot } | null = null
    let peekExitRequested = false
    let relocation: Relocation | null = null
    let previousMood = latest.current.mood
    let previousMessage = latest.current.message?.key
    const bits = petBits()
    const live = new Set<Animation>()
    const waits = new Set<Waiter>()
    let memory = freshMemory()
    let scriptedLook = { x: 0, y: 0 }
    let gazeFrame = 0
    let gazeAt = 0
    let trackingPointer = false
    let journeys = 0
    let turning = false
    let pointerBehindSince: number | null = null
    let nextPointerTurnAt = 0
    const lookAt = (next: Spot) => { scriptedLook = next; if (!trackingPointer) setLook(next) }
    const pointerNearby = (at: Spot) => {
      const center = surface.kind === 'wall'
        ? { x: at.x + skin.height / 2 * surface.inward, y: at.y }
        : { x: at.x, y: at.y - skin.height / 2 + (currentPose === 'sit' || currentPose === 'nap' ? skin.height * .22 : 0) }
      return pointer !== null && petPointerNear(pointer, center, skin.width, trackingPointer)
    }
    const stopGaze = (restore = false) => {
      cancelAnimationFrame(gazeFrame); gazeFrame = 0; pointerBehindSince = null
      if (restore && trackingPointer) { trackingPointer = false; setLook(scriptedLook) }
    }
    const followPointer = (now: number) => {
      gazeFrame = 0
      if (!alive || reduced || still || draggingNow || useBackgroundRest.getState().resting) { stopGaze(); return }
      if (!pointer) { stopGaze(true); return }
      if (now - gazeAt >= 32) {
        gazeAt = now
        const matrix = new DOMMatrix(getComputedStyle(walker).transform)
        if (!pointerNearby({ x: matrix.e, y: matrix.f })) { stopGaze(true); return }
        const origin = skin.gazeOrigin ?? { x: skin.width / 2, y: skin.height * .35 }
        const shifted = currentPose === 'sit' ? { x: origin.x, y: origin.y + skin.height * .22 } : origin
        const next = petPointerLook(pointer, matrix, shifted, skin.width, skin.height, face)
        setLook((before) => Math.abs(before.x - next.x) + Math.abs(before.y - next.y) > .003 ? next : before)
        considerPointerTurn(pointer, matrix, now)
      }
      gazeFrame = requestAnimationFrame(followPointer)
    }
    const startGaze = (at: Spot) => {
      if (reduced || still || draggingNow || useBackgroundRest.getState().resting) { stopGaze(); return }
      if (!pointerNearby(at)) { stopGaze(true); return }
      trackingPointer = true
      if (!gazeFrame) gazeFrame = requestAnimationFrame(followPointer)
    }

    const bounds = (): Rect => ({ left: 0, top: 0, right: stage.clientWidth, bottom: stage.clientHeight })
    const local = (r: Rect): Rect => {
      const origin = stage.getBoundingClientRect()
      return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top }
    }
    const avoid = () => avoidRects(document).map(local)
    const transform = (at = pos) => `translate(${at.x}px, ${at.y}px) rotate(${rotation(surface)}deg)`
    const apply = () => { walker.style.transform = transform(); position.current = pos }
    const guard = (expected: number) => { if (!alive || gen !== expected) throw new Interrupted() }
    const body = (at: Spot): Rect => ({ left: at.x - skin.width / 2, right: at.x + skin.width / 2, top: at.y - skin.height, bottom: at.y + (currentPose === 'sit' || currentPose === 'nap' ? skin.height * .22 : 0) })
    const occupied = (at: Spot): Rect | null => {
      if (!peeking) return body(at)
      if (currentPose === 'peek') return visiblePeekHead(peeking.plan, at)
      const r = body(at), clip = peeking.plan.clip
      const visible = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right), top: Math.max(r.top, clip.top), bottom: Math.min(r.bottom, clip.bottom) }
      return visible.right > visible.left && visible.bottom > visible.top ? visible : null
    }
    const free = (at: Spot) => {
      const visible = occupied(at)
      return !visible || !avoid().some((r) => overlaps(visible, r))
    }
    const fit = (at: Spot): Spot => {
      const b = bounds()
      return { x: clamp(at.x, skin.width / 2 + 4, b.right - skin.width / 2 - 4), y: clamp(at.y, skin.height + 4, b.bottom - (currentPose === 'sit' || currentPose === 'nap' ? skin.height * .22 : 0) - 4) }
    }
    const perches = () => {
      const sources: PerchSource[] = []
      const root = stage.parentElement ?? document
      const dividers = '[role="separator"][aria-orientation="vertical"]'
      for (const [index, element] of [...root.querySelectorAll(`[data-pet-perch], .sidebar, .chat-dock, .task-card, .statusbar, ${dividers}`)].entries()) {
        if (element.getAttribute('data-dragging') === 'true' || element.getAttribute('data-closing') === 'true') continue
        if (element.matches('.sidebar') && element.querySelector(dividers)) continue
        const box = local(element.getBoundingClientRect())
        if (box.right <= box.left || box.bottom <= box.top) continue
        const kind = element.matches(dividers) ? 'divider' : element.getAttribute('data-pet-perch') === 'wall' || element.matches('.sidebar') ? 'wall' : 'ledge'
        sources.push({ id: element.getAttribute('data-pet-anchor') ?? `${kind}:${index}`, kind, rect: box })
      }
      return perchesOf(sources, bounds(), avoid())
    }
    const safe = (preferred: Spot): Spot | null => {
      const first = fit(preferred)
      if (free(first)) return first
      const candidates = perches().filter(isLedge).map((p) => fit({ x: (p.from.x + p.to.x) / 2, y: p.from.y }))
      const supported = candidates.filter(free).sort((a, b) => distance(first, a) - distance(first, b))[0]
      if (supported) return supported
      const b = bounds()
      for (let y = b.bottom - 32; y >= skin.height; y -= skin.height / 2) {
        for (const x of [skin.width / 2 + 8, b.right - skin.width / 2 - 8]) candidates.push(fit({ x, y }))
      }
      return candidates.filter(free).sort((a, b) => distance(first, a) - distance(first, b))[0] ?? null
    }
    const homeSpot = () => {
      const footer = stage.parentElement?.querySelector('.statusbar, .pg-statusbar')
      const y = footer ? local(footer.getBoundingClientRect()).top : bounds().bottom - 4
      return safe(latest.current.home?.(bounds()) ?? { x: skin.width / 2 + 24, y }) ?? fit(pos)
    }
    const changePose = (next: PetPose) => {
      currentPose = next
      if (next === 'peek' && skin.head) {
        const { bounds: h } = skin.head, pad = skin.width * .08
        const left = (face > 0 ? h.left : skin.width - h.right) - pad
        const right = (face > 0 ? h.right : skin.width - h.left) + pad
        walker.style.clipPath = `inset(${Math.max(0, h.top - pad)}px ${Math.max(0, skin.width - right)}px ${Math.max(0, skin.height - h.bottom - pad)}px ${Math.max(0, left)}px)`
      } else walker.style.clipPath = ''
      if (alive) setPose(next)
    }
    const actualPosition = () => {
      const matrix = new DOMMatrix(getComputedStyle(walker).transform)
      return Number.isFinite(matrix.e) && Number.isFinite(matrix.f) ? { x: matrix.e, y: matrix.f } : pos
    }
    const clearPeek = () => {
      if (!peeking) return
      peeking = null
      peekExitRequested = false
      delete walker.dataset.peeking
      surface = { kind: 'floor' }
      changePose(latest.current.mood)
      lookAt({ x: 0, y: 0 }); setClip(null)
    }
    const interrupt = () => {
      gen++
      pointerBehindSince = null
      const wasAirborne = walker.hasAttribute('data-airborne')
      if (live.size) pos = actualPosition()
      for (const animation of live) animation.cancel()
      live.clear()
      for (const entry of waits) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.reject(new Interrupted())
      }
      waits.clear()
      saying?.finish(false)
      walker.style.opacity = ''
      delete walker.dataset.airborne
      setWalking(false)
      if (peeking) peekExitRequested = true
      else { changePose(latest.current.mood); setClip(null) }
      if (wasAirborne && alive) {
        const ledge = ledgeBelow(perches(), pos)
        relocation = { to: safe({ x: pos.x, y: ledge.from.y }) ?? homeSpot(), kind: 'fall' }
      }
      apply()
    }
    const wait = (ms: number, expected: number) => new Promise<void>((resolve, reject) => {
      let remaining = ms
      let last = performance.now()
      const entry: Waiter = { timer: null, reject }
      const tick = () => {
        if (!alive || gen !== expected) { waits.delete(entry); reject(new Interrupted()); return }
        const now = performance.now()
        if (!still) remaining -= now - last
        last = now
        if (remaining <= 0) { waits.delete(entry); resolve() }
        else entry.timer = setTimeout(tick, Math.min(remaining, 100))
      }
      waits.add(entry)
      entry.timer = setTimeout(tick, Math.min(ms, 100))
    })
    const animate = async (element: HTMLElement, frames: Keyframe[], duration: number, expected: number, easing = 'ease-in-out') => {
      guard(expected)
      if (reduced || duration <= 0) return
      const animation = element.animate(frames, { duration, easing, fill: 'forwards' })
      live.add(animation)
      if (still) animation.pause()
      try { await animation.finished } catch { guard(expected) }
      finally { live.delete(animation); animation.cancel() }
      guard(expected)
    }
    const turnOnto = async (onto: Surface, expected: number) => {
      guard(expected)
      if (rotation(surface) === rotation(onto)) { surface = onto; return }
      const from = transform()
      surface = onto
      await animate(walker, [{ transform: from }, { transform: transform() }], 220, expected)
      apply()
    }
    const turn = async (direction: 1 | -1, expected: number) => {
      guard(expected)
      while (turning) await wait(20, expected)
      guard(expected)
      if (face === direction) return
      const previous = face
      const snapshot = facing.cloneNode(true)
      face = direction
      pointerBehindSince = null
      nextPointerTurnAt = performance.now() + 650
      facing.style.transform = `scaleX(${face})`
      if (reduced || !(snapshot instanceof HTMLElement)) return
      turning = true
      // Cross-fade the profiles without squeezing the body through scaleX(0).
      turnLayer.append(snapshot)
      try {
        await Promise.all([
          animate(snapshot, [{ opacity: 1, transform: `scaleX(${previous})` }, { opacity: 0, transform: `scaleX(${previous}) scale(.98)` }], 160, expected, 'ease-out'),
          animate(facing, [{ opacity: 0, transform: `scaleX(${face}) scale(.98)` }, { opacity: 1, transform: `scaleX(${face})` }], 160, expected, 'ease-out')
        ])
      } finally { snapshot.remove(); turning = false }
    }
    const considerPointerTurn = (target: Spot, matrix: DOMMatrix, now: number) => {
      if (journeys || turning || live.size || peeking || surface.kind === 'wall' || currentPose === 'nap' || currentPose === 'hang' || ONE_SHOT_POSES.has(currentPose) || now < nextPointerTurnAt) {
        pointerBehindSince = null
        return
      }
      const direction = petPointerFacing(target, matrix, skin.width, face)
      if (direction === face) { pointerBehindSince = null; return }
      if (pointerBehindSince === null) pointerBehindSince = now
      if (now - pointerBehindSince < 220) return
      void turn(direction, gen).catch((error: unknown) => { if (!(error instanceof Interrupted)) console.error(error) })
    }
    const hop = async (to: Spot, onto: Surface, expected: number) => {
      guard(expected)
      const destination = safe(to)
      if (!destination) return false
      if (reduced) { pos = destination; surface = onto; apply(); return true }
      if (distance(pos, destination) < 1) { await turnOnto(onto, expected); return true }
      const b = bounds()
      const flightBounds = { left: skin.width / 2 + 4, right: b.right - skin.width / 2 - 4, top: skin.height + 4, bottom: b.bottom - 4 }
      const blocked = avoid().map((r) => ({ left: r.left - skin.width / 2, right: r.right + skin.width / 2, top: r.top, bottom: r.bottom + skin.height }))
      const flight = planFlight(pos, destination, blocked, flightBounds, skin.width)
      if (!flight) return false
      journeys++
      try {
        setWalking(false); changePose(latest.current.mood)
        await turnOnto({ kind: 'floor' }, expected)
        if (Math.abs(destination.x - pos.x) > 4) await turn(destination.x > pos.x ? 1 : -1, expected)
        await animate(walker, [{ transform: transform() }, { transform: `${transform()} scale(1,.94)` }, { transform: transform() }], 100, expected)
        changePose('jumping'); walker.dataset.airborne = ''
        await animate(walker, flight.points.map(({ at, offset }) => ({ transform: transform(at), offset })), flight.duration, expected, 'linear')
        pos = destination; apply()
        delete walker.dataset.airborne
        changePose(latest.current.mood)
        await animate(walker, [{ transform: `${transform()} scale(1,.94)` }, { transform: transform() }], 160, expected, 'ease-out')
        await turnOnto(onto, expected)
        return true
      } finally {
        journeys--
        if (gen === expected) { delete walker.dataset.airborne; changePose(latest.current.mood) }
      }
    }
    const fall = async (to: Spot, expected: number) => {
      guard(expected)
      const destination = safe(to)
      if (!destination) return
      const from = transform()
      surface = { kind: 'floor' }
      if (reduced || distance(pos, destination) < 1) { pos = destination; apply(); return }
      const start = pos
      const at = (progress: number): Spot => ({
        x: start.x + (destination.x - start.x) * progress,
        y: start.y + (destination.y - start.y) * progress * progress
      })
      const duration = clamp(Math.sqrt(Math.max(0, destination.y - start.y)) * 36, 220, 650)
      journeys++
      try {
        setWalking(false); changePose('jumping'); walker.dataset.airborne = ''
        await animate(walker, [
          { transform: from, offset: 0 },
          { transform: transform(at(.35)), offset: .35 },
          { transform: transform(at(.7)), offset: .7 },
          { transform: transform(destination), offset: 1 }
        ], duration, expected, 'linear')
        pos = destination; apply()
        delete walker.dataset.airborne
        changePose(latest.current.mood)
        await animate(walker, [{ transform: `${transform()} scale(1.08,.9)` }, { transform: transform() }], 180, expected, 'ease-out')
      } finally {
        journeys--
        if (gen === expected) { delete walker.dataset.airborne; changePose(latest.current.mood) }
      }
    }
    const travel = async (to: Spot, sprint: boolean, onto: Surface, expected: number) => {
      const destination = safe(to)
      if (!destination) return
      const all = perches()
      const blocked = avoid().map((r) => ({ left: r.left - skin.width / 2, right: r.right + skin.width / 2, top: r.top, bottom: r.bottom + skin.height }))
      const { speed } = petGait(skin.width, sprint)
      const path = reduced ? [{ kind: 'hop' as const, to: destination }] : planPath(pos, destination, blocked, { speed, walls: all.filter(isWall).map((p) => p.from.x), supports: all })
      journeys++
      try {
        for (const leg of path) {
          guard(expected)
          if (leg.kind === 'hop') { if (!await hop(leg.to, onto, expected)) return; continue }
          setWalking(false)
          changePose(latest.current.mood)
          if (leg.kind === 'climb') {
            const wall = all.find((p) => isWall(p) && Math.abs(p.from.x - leg.to.x) < 1)
            await turnOnto({ kind: 'wall', inward: wall?.inward ?? 1 }, expected)
          } else await turnOnto({ kind: 'floor' }, expected)
          const facingDelta = leg.kind === 'walk' ? leg.to.x - pos.x : (leg.to.y - pos.y) * (surface.kind === 'wall' ? surface.inward : 1)
          await turn(facingDelta >= 0 ? 1 : -1, expected)
          changePose(sprint ? 'sprint' : latest.current.mood)
          setWalking(true)
          await animate(walker, [{ transform: transform() }, { transform: transform(leg.to) }], distance(pos, leg.to) / speed * 1000, expected, 'linear')
          pos = leg.to; apply()
          setWalking(false)
          changePose(latest.current.mood)
        }
        await turnOnto(onto, expected)
      } finally {
        journeys--
        if (alive && gen === expected) { setWalking(false); changePose(latest.current.mood) }
      }
    }
    const leavePeek = async (expected: number) => {
      guard(expected)
      const owner = peeking
      if (!owner) return null
      peekExitRequested = false
      walker.dataset.peeking = 'leaving'
      if (currentPose === 'peek') {
        await animate(walker, [{ transform: transform() }, { transform: transform(owner.plan.hidden) }], 420, expected, 'ease-in')
        pos = owner.plan.hidden; apply()
        changePose(latest.current.mood)
        await wait(20, expected)
      }
      const approach = fit(owner.approach)
      await animate(walker, [{ transform: transform() }, { transform: transform(approach) }], 350, expected, 'ease-out')
      pos = approach; apply(); clearPeek()
      return owner.returnTo
    }
    const peekFrom = async (wall: Perch, expected: number) => {
      guard(expected)
      if (reduced || !skin.head) return
      const plan = planPeek(wall, skin.head, skin.width, skin.height, bounds(), avoid(), .2 + Math.random() * .6)
      if (!plan) return
      const approach = { x: wall.from.x + plan.facing * (skin.width / 2 + 8), y: plan.hidden.y }
      if (distance(approach, fit(approach)) > 1 || !free(approach)) return
      const owner = { plan, approach, returnTo: homeSpot() }
      try {
        await travel(approach, false, { kind: 'floor' }, expected)
        if (distance(pos, approach) > 1) return
        await turn(plan.facing, expected)
        peeking = owner
        setWalking(false); changePose('idle'); lookAt({ x: 0, y: 0 }); setClip(plan.clip)
        walker.dataset.peeking = 'entering'
        await wait(20, expected)
        await animate(walker, [{ transform: transform() }, { transform: transform(plan.hidden) }], 350, expected, 'ease-in')
        pos = plan.hidden; apply(); changePose('peek')
        await wait(20, expected)
        await animate(walker, [{ transform: transform() }, { transform: transform(plan.shown) }], 480, expected, 'ease-out')
        pos = plan.shown; apply(); walker.dataset.peeking = 'watching'
        lookAt({ x: -.8, y: .4 }); await wait(900, expected)
        lookAt({ x: .85, y: -.25 }); await wait(1000, expected)
        lookAt({ x: 0, y: .2 }); await wait(650, expected)
        await leavePeek(expected)
        await travel(owner.returnTo, false, { kind: 'floor' }, expected)
      } finally {
        if (peeking === owner) peekExitRequested = true
      }
    }
    const bubblePosition = (): { at: Spot; below: boolean } | null => {
      const b = bounds(), width = Math.min(bubbleRef.current?.offsetWidth ?? 260, b.right - 24), height = bubbleRef.current?.offsetHeight ?? 64
      const x = clamp(pos.x, width / 2 + 12, b.right - width / 2 - 12)
      for (const below of [false, true]) {
        const y = below ? pos.y + 12 : pos.y - skin.height - 12
        const r = { left: x - width / 2, right: x + width / 2, top: below ? y : y - height, bottom: below ? y + height : y }
        if (r.top >= 8 && r.bottom <= b.bottom - 8 && !avoid().some((other) => overlaps(r, other))) return { at: { x, y }, below }
      }
      return null
    }
    const say = async (next: Say, expected: number) => {
      guard(expected)
      const at = bubblePosition()
      if (!at) { await wait(2000, expected); return }
      await new Promise<void>((resolve) => {
        const finish = (consume: boolean) => {
          if (consume) {
            consumed.current.add(next.key)
            if (consumed.current.size > 100) { const first = consumed.current.values().next().value; if (first) consumed.current.delete(first) }
          }
          if (saying?.message === next) { saying = null; if (alive) setBubble(null) }
          resolve()
        }
        saying = { message: next, finish }
        setBubble({ message: next, ...at, close: () => finish(true) })
        if (next.holdMs !== null) void wait(next.holdMs, expected).then(() => finish(true)).catch(() => finish(false))
      })
      guard(expected)
    }
    const apiFor = (expected: number): StageApi => ({
      spot: () => pos, facing: () => face, surface: () => surface, bounds, perches, home: homeSpot,
      pointer: (options) => options?.nearby && !pointerNearby(live.size ? actualPosition() : pos) ? null : pointer, random: Math.random,
      standingSpot: (anchor) => safe(standingSpot(local(anchor), bounds(), skin.width)) ?? homeSpot(),
      pose: (next) => { guard(expected); changePose(next) },
      look: (x, y) => { guard(expected); lookAt({ x, y }) },
      face: (direction) => turn(direction, expected),
      walkTo: (to, options = {}) => travel(to, options.sprint ?? false, options.onto ?? { kind: 'floor' }, expected),
      hopTo: async (to, onto = { kind: 'floor' }) => { await hop(to, onto, expected) },
      peekFrom: (wall) => peekFrom(wall, expected),
      once: async (next) => { guard(expected); changePose(next); await wait(900, expected); changePose(latest.current.mood) },
      wait: (ms) => wait(ms, expected),
      clip: (r) => { guard(expected); setClip(r) },
      say: (next) => say(next, expected)
    })
    commands.current = {
      play: (id) => { const bit = bits.find((b) => b.id === id); if (bit) { interrupt(); forced = bit } },
      pose: (next) => { interrupt(); changePose(next) },
      interrupt,
      bits: () => bits.map((b) => b.id)
    }

    const tick = () => {
      if (!alive) return
      const reason = hideReason(document)
      const nextStill = useBackgroundRest.getState().resting || reason !== null
      if (still !== nextStill) {
        still = nextStill
        for (const animation of live) { if (still) animation.pause(); else animation.play() }
      }
      if (peeking && !peekExitRequested && walker.dataset.peeking !== 'leaving' && !still) {
        const before = peeking.plan.wall
        const current = perches().find((p) => p.id === before.id)
        if (!current || distance(current.from, before.from) > 1 || distance(current.to, before.to) > 1) interrupt()
      }
      if (!peeking && !still && !draggingNow && journeys === 0 && live.size === 0 && surface.kind === 'wall' && !supportingWall(perches(), pos, surface.inward)) {
        interrupt()
        const ledge = ledgeBelow(perches(), pos)
        relocation = { to: safe({ x: pos.x, y: ledge.from.y }) ?? homeSpot(), kind: 'fall' }
        return
      }
      const at = live.size ? actualPosition() : pos
      startGaze(at)
      const blocked = !free(at)
      setHidden(reason ?? (blocked && !safe(at) ? 'blocked' : null))
      if (still || draggingNow) return
      if (previousMood !== latest.current.mood) {
        const was = previousMood
        previousMood = latest.current.mood
        interrupt()
        if (previousMood === 'waiting' || was === 'running') urge = 'greet'
      }
      if (previousMessage !== latest.current.message?.key) { previousMessage = latest.current.message?.key; interrupt() }
      if (blocked && urge !== 'yield') { interrupt(); urge = 'yield' }
      if (saying) {
        const anchor = saying.message.anchor()
        if (anchor) {
          const destination = safe(standingSpot(local(anchor), bounds(), skin.width))
          if (destination && distance(pos, destination) > 2) { interrupt(); return }
        }
        const placement = bubblePosition()
        if (placement) setBubble((was) => was ? { ...was, ...placement } : null)
        else saying.finish(false)
      }
      if (pointer && hoverSince && Date.now() - hoverSince > 800 && !saying && !reduced && urge === null) {
        interrupt(); urge = 'flee'; hoverSince = 0
      }
    }
    const layoutChanged = () => {
      if (draggingNow) return
      if (!saying) interrupt()
      const destination = relocation?.to ?? safe(pos) ?? homeSpot()
      if (!peeking && distance(pos, destination) > 1 && !relocation) relocation = { to: destination, kind: 'hop' }
      tick()
    }
    const onMove = (event: PointerEvent) => {
      const origin = stage.getBoundingClientRect()
      pointer = { x: event.clientX - origin.left, y: event.clientY - origin.top }
      activityAt = Date.now()
      const at = live.size ? actualPosition() : pos
      startGaze(at)
      const hit = occupied(at)
      const hovering = hit && pointer.x > hit.left && pointer.x < hit.right && pointer.y > hit.top && pointer.y < hit.bottom
      if (!hovering) hoverSince = 0
      else if (!hoverSince) hoverSince = Date.now()
    }
    const onLeave = () => { pointer = null; hoverSince = 0; stopGaze(true) }
    const onKey = (event: KeyboardEvent) => {
      activityAt = Date.now()
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], .xterm')) {
        typingUntil = Date.now() + 10_000
        if (live.size || peeking) interrupt()
      }
    }
    const greet = () => { if (saying) { saying.message.open?.(); saying.finish(true) } else { interrupt(); urge = 'greet' } }
    const onWalkerKey = (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); greet() } }
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !alive) return
      const clickedMessage = saying?.message
      const heldHead = peeking ? actualPosition() : null
      event.preventDefault(); interrupt(); draggingNow = true
      const origin = stage.getBoundingClientRect()
      const start = { x: event.clientX - origin.left, y: event.clientY - origin.top }
      const grabbed = heldHead ?? pos
      const grip = { x: start.x - grabbed.x, y: start.y - grabbed.y }
      let moved = false
      const move = (e: PointerEvent) => {
        const at = { x: e.clientX - origin.left, y: e.clientY - origin.top }
        if (!moved && distance(at, start) < 4) return
        moved = true; clearPeek(); relocation = null; surface = { kind: 'floor' }; setDragging(true); changePose('hang')
        pos = fit({ x: at.x - grip.x, y: at.y - grip.y }); apply(); walker.style.opacity = ''
      }
      const up = () => {
        walker.removeEventListener('pointermove', move); walker.removeEventListener('pointerup', up); walker.removeEventListener('pointercancel', up)
        releaseDrag = null
        if (!alive) return
        walker.style.opacity = ''
        setDragging(false)
        if (!moved) {
          draggingNow = false
          if (clickedMessage) { consumed.current.add(clickedMessage.key); clickedMessage.open?.() }
          else greet()
          return
        }
        const expected = gen
        const ledge = ledgeBelow(perches(), pos)
        const to = safe({ x: pos.x, y: ledge.from.y }) ?? homeSpot()
        void (async () => {
          await animate(walker, [{ transform: transform() }, { transform: transform(to) }], 220, expected, 'ease-in')
          pos = to; apply()
          await animate(walker, [{ transform: `${transform()} scale(1.08,.9)` }, { transform: transform() }], 180, expected)
        })().catch(() => {}).finally(() => { draggingNow = false; if (alive) changePose(latest.current.mood) })
      }
      releaseDrag = up
      walker.setPointerCapture(event.pointerId)
      walker.addEventListener('pointermove', move); walker.addEventListener('pointerup', up); walker.addEventListener('pointercancel', up)
    }
    walker.addEventListener('pointerdown', onDown)
    walker.addEventListener('keydown', onWalkerKey)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('mouseleave', onLeave)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', layoutChanged)
    // Scrolling leaves the stage fixed; tick rechecks moved anchors and obstacles.
    const resize = new ResizeObserver(layoutChanged)
    resize.observe(stage)
    const ticker = setInterval(tick, 200)
    pos = safe(position.current ?? homeSpot()) ?? homeSpot()
    facing.style.transform = `scaleX(${face})`
    apply(); changePose(latest.current.mood); tick()

    void (async () => {
      while (alive) {
        const expected = gen
        try {
          if (still || draggingNow) { await wait(200, expected); continue }
          if (peekExitRequested) {
            const returnTo = await leavePeek(expected)
            if (returnTo) await travel(returnTo, false, { kind: 'floor' }, expected)
            continue
          }
          if (relocation) {
            const { to, kind } = relocation
            relocation = null
            if (kind === 'fall') await fall(to, expected)
            else await hop(to, { kind: 'floor' }, expected)
            continue
          }
          const now = Date.now()
          const c: Context = {
            now, level, mood: latest.current.mood, reduced, typingUntil, idleFor: now - activityAt,
            pointer, pointerDistance: pointer ? distance(pointer, pos) : null, urge,
            message: latest.current.message && !consumed.current.has(latest.current.message.key) ? latest.current.message : null,
            on: currentSurface().kind === 'wall' ? 'wall' : pos.y >= bounds().bottom - 40 ? 'floor' : 'ledge', random: Math.random
          }
          const bit = forced ?? pickBit(bits, c, memory)
          forced = null
          if (bit) {
            await bit.run(apiFor(expected), c)
            memory = remember(memory, bit.id, Date.now())
            if (bit.id === urge) urge = null
          }
          await wait(bit && bit.cooldownMs > 0 ? restMs(level, Math.random) : 400, expected)
        } catch (error) {
          if (!(error instanceof Interrupted)) { console.error(error); await new Promise((resolve) => setTimeout(resolve, 500)) }
        }
      }
    })()
    return () => {
      alive = false; releaseDrag?.(); interrupt(); commands.current = null
      clearInterval(ticker); cancelAnimationFrame(gazeFrame); resize.disconnect()
      walker.removeEventListener('pointerdown', onDown); walker.removeEventListener('keydown', onWalkerKey)
      window.removeEventListener('pointermove', onMove); document.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', layoutChanged)
    }
  }, [skin, level, reduced])

  if (level === 'off') return null
  const stage = stageRef.current
  const clipStyle = clip && stage ? { clipPath: `inset(${clip.top}px ${stage.clientWidth - clip.right}px ${stage.clientHeight - clip.bottom}px ${clip.left}px)` } : undefined
  return (
    <div ref={stageRef} className="pet-stage" data-hidden={hidden ?? undefined} data-paused={hidden !== null || undefined}>
      <div className="pet-clip" style={clipStyle}>
        <div ref={walkerRef} className="pet-walker" role="button" tabIndex={hidden ? -1 : 0} aria-label={t('Pet.ariaName')} style={{ width: skin.width, height: skin.height, marginLeft: -skin.width / 2, marginTop: -skin.height }} data-dragging={dragging || undefined}>
          <div ref={facingRef} className="pet-facing">{skin.render({ pose, walking, lookX: look.x, lookY: look.y, reduced })}</div>
          <div ref={turnRef} className="pet-turn" aria-hidden="true" />
        </div>
      </div>
      {bubble && <div ref={bubbleRef} className="pet-bubble" role="status" style={{ left: bubble.at.x, top: bubble.at.y }} data-below={bubble.below || undefined}>
        <PetSpeech text={bubble.message.text} open={() => { bubble.message.open?.(); bubble.close() }} dismiss={bubble.close} />
      </div>}
    </div>
  )
}

export { ONE_SHOT_POSES }
