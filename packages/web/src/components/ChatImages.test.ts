import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatImageStrip } from './ChatImages'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

const images = [
  { id: `${'a'.repeat(64)}.png`, width: 1600, height: 400 },
  { id: `${'b'.repeat(64)}.png`, width: 400, height: 1600 },
  { id: `${'c'.repeat(64)}.png`, width: 800, height: 800 }
]

describe('image thumbnails', () => {
  it('sets composer and sent thumbnails in the same square regardless of the original shape', () => {
    const composer = renderToStaticMarkup(createElement(ChatImageStrip, { images, onRemove: () => {} }))
    expect(composer.match(/data-square=""/g)).toHaveLength(images.length)
    expect(composer).not.toContain('aspect-ratio')
    const sent = renderToStaticMarkup(createElement(ChatImageStrip, { images }))
    expect(sent.match(/data-square=""/g)).toHaveLength(images.length)
    expect(sent).not.toContain('aspect-ratio')
    expect(composer).toContain('aria-label="删除图片"')
    expect(sent).not.toContain('aria-label="删除图片"')
  })
})
