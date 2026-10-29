import { describe, expect, it } from 'vitest'
import { clampPan, FITTED, fitScale, MAX_SCALE, overhangs, scaleOf, turn, zoomBy } from './image-view'

const photo = { width: 4000, height: 2000 }
const stage = { width: 1000, height: 800 }

describe('image view', () => {
  it('fits the image to the stage, and a small one at its own size', () => {
    expect(fitScale(photo, stage, 0)).toBe(0.25)
    expect(fitScale({ width: 200, height: 100 }, stage, 0)).toBe(1)
  })

  it('fits a quarter-turned image by its turned sides', () => {
    expect(fitScale(photo, stage, 1)).toBe(0.2)
    expect(fitScale(photo, stage, -3)).toBe(0.2)
    expect(scaleOf(turn(FITTED, 1), photo, stage)).toBe(0.2)
  })

  it('zooms toward the point under the pointer, kept within the overhang', () => {
    const view = zoomBy(FITTED, 2, photo, stage, { x: 400, y: 0 })
    expect(view.zoom).toBe(2)
    // 2000 × 1000 shown in a 1000 × 800 stage: 500 of room each way across, 100 up and down.
    expect(view.pan).toEqual({ x: -400, y: 0 })
    expect(clampPan({ x: -900, y: 300 }, photo, stage, view)).toEqual({ x: -500, y: 100 })
  })

  it('stops at the largest scale', () => {
    const view = zoomBy(FITTED, 1000, photo, stage)
    expect(scaleOf(view, photo, stage)).toBe(MAX_SCALE)
  })

  it('lets the image be dragged only once it is bigger than the stage', () => {
    expect(overhangs(photo, stage, FITTED)).toBe(false)
    expect(overhangs(photo, stage, { zoom: 1.5, turns: 0 })).toBe(true)
  })

  it('starts the pan over on a turn, zoom kept', () => {
    expect(turn({ zoom: 2, turns: 3, pan: { x: 10, y: 20 } }, 1)).toEqual({ zoom: 2, turns: 4, pan: { x: 0, y: 0 } })
  })
})
