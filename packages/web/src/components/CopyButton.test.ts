import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CopyButton } from './CopyButton'

describe('copy button', () => {
  it('shows the value it copies before its icon, where given one', () => {
    const html = renderToStaticMarkup(createElement(CopyButton, { text: '841ff28f0c', label: '复制完整 SHA' }, createElement('span', { className: 'mono' }, '841ff28f')))
    expect(html).toContain('class="copy-button copy-button-text"')
    expect(html).toContain('title="复制完整 SHA"')
    expect(html).toContain('<span class="mono">841ff28f</span><svg')
  })

  it('stays an icon alone otherwise', () => {
    expect(renderToStaticMarkup(createElement(CopyButton, { text: 'x' }))).toContain('class="copy-button"')
  })
})
