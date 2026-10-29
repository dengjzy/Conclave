import { describe, expect, it } from 'vitest'
import { avoidRects, hideReason, type YieldDocument } from './pet-yield'

type Fake = { selector: string; rect: { left: number; top: number; right: number; bottom: number } }

function element(fake: Fake): Element {
  const box = { ...fake.rect, width: fake.rect.right - fake.rect.left, height: fake.rect.bottom - fake.rect.top, x: fake.rect.left, y: fake.rect.top, toJSON: () => '' }
  const matches = (selectors: string) => selectors.split(',').some((part) => fake.selector.split(' ').includes(part.trim()))
  return { matches, getBoundingClientRect: () => box } as unknown as Element
}

function doc(options: { hidden?: boolean; elements?: Fake[]; active?: Fake | null; selection?: Fake | null } = {}): YieldDocument {
  const elements = (options.elements ?? []).map((fake) => ({ fake, element: element(fake) }))
  const find = (selectors: string) => elements.filter(({ element }) => element.matches(selectors)).map(({ element }) => element)
  return {
    hidden: options.hidden ?? false,
    activeElement: options.active ? element(options.active) : null,
    querySelector: (selectors) => find(selectors)[0] ?? null,
    querySelectorAll: (selectors) => find(selectors),
    getSelection: () => options.selection
      ? { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ getBoundingClientRect: () => element(options.selection!).getBoundingClientRect() }) }
      : { isCollapsed: true, rangeCount: 0, getRangeAt: () => { throw new Error('none') } }
  }
}

describe('hideReason', () => {
  it('hides for a hidden page or an open dialog or menu', () => {
    expect(hideReason(doc())).toBeNull()
    expect(hideReason(doc({ hidden: true }))).toBe('hidden')
    expect(hideReason(doc({ elements: [{ selector: 'dialog[open]', rect: { left: 0, top: 0, right: 10, bottom: 10 } }] }))).toBe('overlay')
    expect(hideReason(doc({ elements: [{ selector: '.context-menu', rect: { left: 0, top: 0, right: 10, bottom: 10 } }] }))).toBe('overlay')
  })
})

describe('avoidRects', () => {
  it('keeps off the browser, toasts and anything marked', () => {
    const rects = avoidRects(doc({ elements: [
      { selector: '.browser-stage', rect: { left: 100, top: 100, right: 500, bottom: 400 } },
      { selector: '.toast', rect: { left: 600, top: 10, right: 800, bottom: 60 } },
      { selector: '[data-pet-avoid]', rect: { left: 0, top: 0, right: 0, bottom: 0 } }
    ] }))
    expect(rects).toEqual([{ left: 100, top: 100, right: 500, bottom: 400 }, { left: 600, top: 10, right: 800, bottom: 60 }])
  })

  it('gives the box being typed in a margin', () => {
    const rects = avoidRects(doc({ active: { selector: 'textarea', rect: { left: 100, top: 500, right: 700, bottom: 560 } } }))
    expect(rects).toEqual([{ left: 76, top: 476, right: 724, bottom: 584 }])
  })

  it('ignores a focused button but not a selection', () => {
    expect(avoidRects(doc({ active: { selector: 'button', rect: { left: 0, top: 0, right: 50, bottom: 20 } } }))).toEqual([])
    expect(avoidRects(doc({ selection: { selector: 'p', rect: { left: 10, top: 20, right: 300, bottom: 40 } } }))).toEqual([{ left: 10, top: 20, right: 300, bottom: 40 }])
  })
})
