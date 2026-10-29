import type { Spot } from './pet-path'

export const PET_FRAME_SIZE = 256

// Landmarks in one atlas cell; antenna tips and bent knees do not define body scale.
export const PET_ART_LAYOUT = {
  clay: {
    head: { left: 56, top: 24, right: 222, bottom: 155 },
    idleNeck: { x: 105, y: 155 }, idleFloor: 253, walkFloor: 254,
    walkNecks: [
      { x: 119, y: 146 }, { x: 119.5, y: 147 }, { x: 117.5, y: 148 }, { x: 120, y: 144 },
      { x: 119, y: 144 }, { x: 120, y: 146 }, { x: 119, y: 148 }, { x: 119.5, y: 145 },
      { x: 117.5, y: 150 }, { x: 117.5, y: 151 }, { x: 117, y: 149 }, { x: 117.5, y: 150 }
    ]
  },
  moss: {
    head: { left: 47, top: 27, right: 208, bottom: 166 },
    idleNeck: { x: 147.5, y: 166 }, idleFloor: 253, walkFloor: 254,
    walkNecks: [
      { x: 143, y: 153 }, { x: 143, y: 153 }, { x: 142.5, y: 155 }, { x: 143, y: 153 },
      { x: 142.5, y: 149 }, { x: 143.5, y: 148 }, { x: 142.5, y: 146 }, { x: 143, y: 148 },
      { x: 143.5, y: 152 }, { x: 143.5, y: 152 }, { x: 142.5, y: 154 }, { x: 143.5, y: 153 }
    ]
  },
  zip: {
    head: { left: 60, top: 26, right: 195, bottom: 145 },
    idleNeck: { x: 144.5, y: 145 }, idleFloor: 253, walkFloor: 254,
    walkNecks: [
      { x: 141.5, y: 145 }, { x: 141.5, y: 146 }, { x: 138, y: 149 }, { x: 143.5, y: 145 },
      { x: 136.5, y: 145 }, { x: 137.5, y: 145 }, { x: 137, y: 141 }, { x: 138, y: 144 },
      { x: 138.5, y: 142 }, { x: 141.5, y: 142 }, { x: 140.5, y: 146 }, { x: 143, y: 145 }
    ]
  }
} as const

export function petWalkLayout(layout: { idleNeck: Spot; walkNecks: readonly Spot[]; idleFloor: number; walkFloor: number }, frame = 0) {
  const { idleNeck, walkNecks, idleFloor, walkFloor } = layout
  const walkNeck = walkNecks[frame] ?? walkNecks[0] ?? idleNeck
  const scaleY = (idleFloor - idleNeck.y) / (walkFloor - walkNeck.y)
  return { x: idleNeck.x - walkNeck.x, y: idleFloor - walkFloor * scaleY, scaleY }
}
