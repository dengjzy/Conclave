import { expect, it } from 'vitest'
import { PLAN_COMMENT_BOX, placeCommentBox, type Bounds } from './plan-comment-place'

const viewport = { width: 800, height: 600 }
const panel = { left: 360, right: 780 }
const passage: Bounds = { left: 420, top: 200, right: 700, bottom: 248 }

function place(over: Partial<Bounds> = {}) {
  return placeCommentBox({ passage: { ...passage, ...over }, anchorX: 560, panel, viewport })
}

it('sits over the passage, centred, and inside the panel', () => {
  expect(place()).toEqual({ left: 560, top: passage.top - PLAN_COMMENT_BOX.height - 8 })
  expect(place({ left: 700, right: 760 }).left).toBe(560)
  const squeezed = placeCommentBox({ passage, anchorX: 410, panel, viewport })
  expect(squeezed.left).toBe(panel.left + PLAN_COMMENT_BOX.width / 2 + 8)
})

it('moves under the passage when the window has no room above', () => {
  const high: Bounds = { left: 420, top: 20, right: 700, bottom: 60 }
  expect(placeCommentBox({ passage: high, anchorX: 560, panel, viewport }).top).toBe(high.bottom + 8)
})
