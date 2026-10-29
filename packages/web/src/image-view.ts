// How the image viewer shows one image: turned in quarter turns, zoomed against the size that fits
// the stage, and moved by a drag once it is bigger than the stage.

export type Size = { width: number; height: number }
export type Point = { x: number; y: number }
export type ImageView = { zoom: number; turns: number; pan: Point }

export const FITTED: ImageView = { zoom: 1, turns: 0, pan: { x: 0, y: 0 } }

export const MIN_SCALE = 0.05
export const MAX_SCALE = 8
export const ZOOM_STEP = 1.25

// The image's box as it stands: a quarter turn swaps its sides. `turns` counts on past a full turn
// either way, so the turn always animates the short way round.
export function turnedSize(natural: Size, turns: number): Size {
  return Math.abs(turns) % 2 === 0 ? natural : { width: natural.height, height: natural.width }
}

// The scale that fits the turned image in the stage, never past its own size.
export function fitScale(natural: Size, stage: Size, turns: number): number {
  const turned = turnedSize(natural, turns)
  if (turned.width <= 0 || turned.height <= 0 || stage.width <= 0 || stage.height <= 0) {
    return 1
  }
  return Math.min(1, stage.width / turned.width, stage.height / turned.height)
}

export function scaleOf(view: ImageView, natural: Size, stage: Size): number {
  return fitScale(natural, stage, view.turns) * view.zoom
}

// Bigger than the stage on some side: there is somewhere to drag it.
export function overhangs(natural: Size, stage: Size, view: Pick<ImageView, 'zoom' | 'turns'>): boolean {
  const scale = fitScale(natural, stage, view.turns) * view.zoom
  const turned = turnedSize(natural, view.turns)
  return turned.width * scale > stage.width + 0.5 || turned.height * scale > stage.height + 0.5
}

// Keeps the image over the stage: no further than its overhang on each side, and centred on an
// axis it does not overhang.
export function clampPan(pan: Point, natural: Size, stage: Size, view: Pick<ImageView, 'zoom' | 'turns'>): Point {
  const scale = fitScale(natural, stage, view.turns) * view.zoom
  const turned = turnedSize(natural, view.turns)
  const room = (length: number, stageLength: number) => Math.max(0, (length * scale - stageLength) / 2)
  const limit = (value: number, max: number) => Math.min(max, Math.max(-max, value))
  return { x: limit(pan.x, room(turned.width, stage.width)), y: limit(pan.y, room(turned.height, stage.height)) }
}

// Zooms by `factor`, keeping the point under `at` (from the stage's centre) where it is.
export function zoomBy(view: ImageView, factor: number, natural: Size, stage: Size, at: Point = { x: 0, y: 0 }): ImageView {
  const fit = fitScale(natural, stage, view.turns)
  const zoom = Math.min(MAX_SCALE / fit, Math.max(MIN_SCALE / fit, view.zoom * factor))
  const applied = zoom / view.zoom
  const pan = { x: at.x - (at.x - view.pan.x) * applied, y: at.y - (at.y - view.pan.y) * applied }
  return { ...view, zoom, pan: clampPan(pan, natural, stage, { zoom, turns: view.turns }) }
}

// A quarter turn either way, zoom kept; the pan starts over, since its axes turn too.
export function turn(view: ImageView, by: 1 | -1): ImageView {
  return { zoom: view.zoom, turns: view.turns + by, pan: { x: 0, y: 0 } }
}
