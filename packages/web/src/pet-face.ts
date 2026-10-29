import type { PetPose, PetRig } from '@conclave/protocol'
export type { PetEye } from '@conclave/protocol'
export type EyeTone = readonly [number, number, number]

export function petFace(rig: PetRig, pose: PetPose, walking: boolean) {
  return rig.faces[walking || pose === 'peek' ? 'idle' : pose]
}
