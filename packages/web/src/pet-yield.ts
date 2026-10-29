import type { Rect } from './pet-path'

// What the pet keeps out of the way of. It is a guest on the interface: it never covers the box
// the user types in, the text they selected, a message that just came up, or the built-in
// browser, which is a native view nothing drawn here can cover anyway. While a dialog or a menu is
// up, it is not there at all.

// The little of a document this reads, so a test can hand it a stand-in.
export type YieldDocument = {
  hidden: boolean
  activeElement: Element | null
  querySelector(selectors: string): Element | null
  querySelectorAll(selectors: string): Iterable<Element>
  getSelection?(): { isCollapsed: boolean; rangeCount: number; getRangeAt(index: number): { getBoundingClientRect(): DOMRectReadOnly } } | null
}

const HIDES = 'dialog[open], :popover-open, .context-menu, .menu'
const AVOIDS = '.browser-stage, .toast, .usage-card, [data-pet-avoid]'
const EDITABLE = 'input, textarea, select, [contenteditable="true"], .xterm'
const TYPING_MARGIN = 24

export const rectOf = (element: Element): Rect => {
  const box = element.getBoundingClientRect()
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
}

const shown = (rect: Rect) => rect.right > rect.left && rect.bottom > rect.top

export function hideReason(doc: YieldDocument): 'hidden' | 'overlay' | null {
  if (doc.hidden) return 'hidden'
  return doc.querySelector(HIDES) ? 'overlay' : null
}

export function avoidRects(doc: YieldDocument): Rect[] {
  const rects: Rect[] = []
  for (const element of doc.querySelectorAll(AVOIDS)) {
    const rect = rectOf(element)
    if (shown(rect)) rects.push(rect)
  }
  const active = doc.activeElement
  if (active && active.matches(EDITABLE)) {
    const rect = rectOf(active)
    if (shown(rect)) rects.push({ left: rect.left - TYPING_MARGIN, top: rect.top - TYPING_MARGIN, right: rect.right + TYPING_MARGIN, bottom: rect.bottom + TYPING_MARGIN })
  }
  const selection = doc.getSelection?.()
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const box = selection.getRangeAt(0).getBoundingClientRect()
    const rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    if (shown(rect)) rects.push(rect)
  }
  return rects
}
