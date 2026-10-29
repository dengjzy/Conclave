import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CountBadge, countChange } from './CountBadge'

describe('count badge', () => {
  it('shows a count still on first render, and nothing at zero', () => {
    const html = renderToStaticMarkup(createElement(CountBadge, { count: 7, title: '7 个待处理' }))
    expect(html).toContain('class="inbox-entry-count"')
    expect(html).toContain('title="7 个待处理"')
    expect(html).toContain('>7</span>')
    expect(html).not.toContain('data-change')
    expect(renderToStaticMarkup(createElement(CountBadge, { count: 0 }))).toBe('')
  })

  it('marks a rise or a fall once settled, restarting on each, and nothing while loading', () => {
    const first = countChange(0, 1, null, true)
    expect(first).toEqual({ up: true, n: 1 })
    expect(countChange(1, 2, first, true)).toEqual({ up: true, n: 2 })
    expect(countChange(2, 1, first, true)).toEqual({ up: false, n: 2 })
    expect(countChange(0, 7, null, false)).toBeNull()
  })
})
