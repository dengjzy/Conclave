import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { useChatTypeface } from '../chat-typeface'
import { DEFAULT_PREFERENCES, usePreferences } from '../preferences'
import { CjkFontPicker } from './CjkFontPicker'
import { Resettable } from './SettingsControls'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
})

// Read the live store instead of Zustand's fixed SSR hydration snapshot.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

beforeEach(() => usePreferences.setState(DEFAULT_PREFERENCES, true))

function Typeface() {
  const typeface = useChatTypeface()
  return createElement('div', typeface)
}

describe('Resettable', () => {
  const render = (changed: boolean) => renderToStaticMarkup(createElement(Resettable, { changed, label: '终端字号', onReset: () => {}, children: createElement('output', null, '13 px') }))

  it('offers the way back only once the value is off its default, keeping its room', () => {
    expect(render(false)).toMatch(/<button[^>]*hidden=""/)
    expect(render(true)).not.toMatch(/<button[^>]*hidden=""/)
    expect(render(true)).toContain('aria-label="终端字号恢复默认"')
  })
})

describe('the chat typeface', () => {
  it('leaves the Chinese to the font that goes with the chosen one, by default', () => {
    expect(renderToStaticMarkup(createElement(Typeface))).toBe('<div data-font-size="14" data-font="system"></div>')
  })

  it('sets Chinese in the family picked for it, whatever the font', () => {
    usePreferences.setState({ chatFont: 'serif', chatCjkFontFamily: 'LXGW WenKai' })
    expect(renderToStaticMarkup(createElement(Typeface))).toContain('style="--chat-font-cjk:&quot;LXGW WenKai&quot;"')
  })
})

describe('CjkFontPicker', () => {
  const render = () => renderToStaticMarkup(createElement(CjkFontPicker, { labelId: 'l', preference: 'chatCjkFontFamily', title: '选择聊天的中文字体' }))

  it('starts on the default, with nothing to pick from yet', () => {
    const html = render()
    expect(html).toMatch(/aria-checked="true"[^>]*>默认</)
    expect(html).not.toContain('font-picker-button')
  })

  it('shows the family picked, in itself', () => {
    usePreferences.setState({ chatCjkFontFamily: 'LXGW WenKai' })
    const html = render()
    expect(html).toMatch(/aria-checked="true"[^>]*>其他</)
    expect(html).toContain('font-family:&quot;LXGW WenKai&quot;">LXGW WenKai<')
  })
})
