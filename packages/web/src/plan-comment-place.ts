// Where the comment box sits beside a selected passage: over it, covering what was read already
// rather than what comes next, unless the window has no room there; centred on the selection and
// kept inside the panel it is in.

export type Bounds = { left: number; top: number; right: number; bottom: number }

// The widest the box grows as a comment is written, and its height, a tool row's.
export const PLAN_COMMENT_BOX = { width: 360, height: 32 } as const

const GAP = 8
const EDGE = 8

export type CommentBoxPlace = { left: number; top: number }

function beside(passage: Bounds, above: boolean): number {
  return above ? passage.top - PLAN_COMMENT_BOX.height - GAP : passage.bottom + GAP
}

function fits(top: number, viewportHeight: number): boolean {
  return top >= EDGE && top + PLAN_COMMENT_BOX.height <= viewportHeight - EDGE
}

export function placeCommentBox({ passage, anchorX, panel, viewport }: {
  passage: Bounds
  anchorX: number
  panel: { left: number; right: number } | null
  viewport: { width: number; height: number }
}): CommentBoxPlace {
  const half = PLAN_COMMENT_BOX.width / 2 + EDGE
  const min = (panel?.left ?? 0) + half
  const max = (panel?.right ?? viewport.width) - half
  return { left: Math.min(Math.max(anchorX, min), max), top: beside(passage, fits(beside(passage, true), viewport.height)) }
}
