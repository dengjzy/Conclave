import { useEffect, useMemo, type CSSProperties } from 'react'
import { BUILTIN_PET, usePetResource } from '../pet-library'
import type { PetResource } from '../pet-resource-cache'
import { PET_FRAME_SIZE, petWalkLayout } from '../pet-art-layout'
import { petGait } from '../pet-gait'
import { petFace } from '../pet-face'
import type { PetPose, PetSkin, PetSkinProps } from './pet-skin'
import { PetEyes } from './PetEyes'
import { PetWorkstation } from './PetWorkstation'
import './pet-sprite.css'

type RegisteredFrames = CSSProperties & { [name: `--pet-step-${number}`]: string }
const FRAME: Record<PetPose, number> = {
  idle: 0, waiting: 1, running: 2, review: 3, failed: 4, waving: 5,
  jumping: 6, sit: 7, nap: 8, hang: 9, peek: 0, sprint: 11
}

export function PetSprite({ resource = BUILTIN_PET, pose, walking, lookX, lookY, reduced, size = 80 }: PetSkinProps & { resource?: PetResource; size?: number }) {
  const { manifest, atlas, walk } = resource
  const { rig, id: style } = manifest
  useEffect(() => {
    if (reduced) return
    const image = new Image(); image.src = walk
    void image.decode().catch(() => {})
  }, [walk, reduced])
  const registration = useMemo(() => {
    const result: RegisteredFrames = {}
    for (const frame of rig.layout.walkNecks.keys()) {
      const placement = petWalkLayout(rig.layout, frame)
      result[`--pet-step-${frame}`] = `translate(${placement.x / PET_FRAME_SIZE * 100}%, ${placement.y / PET_FRAME_SIZE * 100}%) scaleY(${placement.scaleY})`
    }
    return result
  }, [rig])
  const frame = FRAME[pose]
  const work = pose === 'running' && !walking && rig.typing && resource.typing ? <PetWorkstation images={resource.typing} rig={rig.typing} /> : null
  const face = petFace(rig, pose, walking)
  const neck = face?.neck ?? rig.layout.idleNeck
  const lean = Math.max(-2.5, Math.min(2.5, lookX - lookY * 2))
  // Keep the whole join fixed, including arms crossing it; a rotated crop opens a wedge there.
  const look: CSSProperties = { transform: reduced ? 'none' : pose === 'peek' ? `rotate(${7 + lookX * 2 - lookY * 2}deg)` : `skewX(${-lean}deg)` }
  const sprite: RegisteredFrames = {
    ...registration,
    backgroundImage: `url(${walking ? walk : atlas})`,
    backgroundPosition: walking ? '0% 0%' : `${(frame % 4) * 100 / 3}% ${Math.floor(frame / 4) * 100 / 3}%`,
    transform: walking ? registration['--pet-step-0'] : undefined
  }
  const timing: CSSProperties & { '--pet-stride-duration': string; '--pet-neck': string; '--pet-neck-x': string; '--pet-arm-edge': string } = {
    '--pet-arm-edge': `${rig.armEdge}%`,
    '--pet-stride-duration': `${petGait(size, pose === 'sprint').cycleMs}ms`,
    '--pet-neck': `${neck.y / PET_FRAME_SIZE * 100}%`,
    '--pet-neck-x': `${neck.x / PET_FRAME_SIZE * 100}%`
  }
  const head = face && <span className="pet-head" style={look}>
    <span className="pet-head-frame" style={{ backgroundImage: `url(${atlas})`, backgroundPosition: walking ? '0% 0%' : sprite.backgroundPosition }} />
    {face.eyes && <PetEyes rig={rig} texture={resource.texture} eyes={face.eyes} tones={face.tones} atlas={atlas} frame={walking ? 0 : frame} lookX={reduced ? 0 : lookX} lookY={reduced ? 0 : lookY} reduced={reduced} />}
  </span>
  const body = <span className="pet-art-body"><span className="pet-art-frame" style={sprite} /></span>
  return (
    <span className="pet-art" style={timing} data-style={style} data-pose={pose} data-working={work ? true : undefined} data-walking={walking || undefined} data-rigged={face ? true : undefined} data-reduced={reduced || undefined} aria-hidden="true">
      {work ?? <>{body}{head}</>}
    </span>
  )
}

export function petSkin(resource: PetResource, size: number): PetSkin {
  const { rig, id } = resource.manifest
  const { head, idleNeck } = rig.layout, scale = size / PET_FRAME_SIZE
  const eyes = rig.faces.idle.eyes ?? []
  return {
    id, width: size, height: size,
    gazeOrigin: eyes.length ? { x: eyes.reduce((sum, eye) => sum + eye.x, 0) / eyes.length * scale, y: eyes.reduce((sum, eye) => sum + eye.y, 0) / eyes.length * scale } : undefined,
    head: { bounds: { left: head.left * scale, top: head.top * scale, right: head.right * scale, bottom: head.bottom * scale }, neck: { x: idleNeck.x * scale, y: idleNeck.y * scale } },
    render: (props) => <PetSprite {...props} resource={resource} size={size} />
  }
}

export function usePetSkin(id: string, size: number, disabled = false): PetSkin {
  const resource = usePetResource(id, disabled)
  return useMemo(() => petSkin(resource, size), [resource, size])
}
