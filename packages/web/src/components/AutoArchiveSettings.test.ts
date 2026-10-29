import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { useCore } from '../core-store'
import { AutoArchiveSettings } from './AutoArchiveSettings'

vi.mock('zustand', async (original) => {
  const actual = await original<typeof import('zustand')>()
  return { ...actual, create: <T>() => (initializer: StateCreator<T>) => {
    const store = actual.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
const render = () => renderToStaticMarkup(createElement(AutoArchiveSettings))
beforeEach(() => useCore.setState(useCore.getInitialState(), true))

describe('auto-archive settings', () => {
  it('is hidden for older cores', () => {
    useCore.setState({ chatSettings: { promptSuggestions: true } })
    expect(render()).toBe('')
  })

  it('is off by default, with no days to pick', () => {
    useCore.setState({ chatSettings: { promptSuggestions: true, autoArchiveDays: null } })
    const html = render()
    expect(html).toContain('自动归档不活跃的会话')
    expect(html).toContain('置顶的会话、任务和群聊里的会话不归档')
    expect(html).not.toContain('多久没有活跃')
  })

  it('offers the days once on, with the chosen one selected', () => {
    useCore.setState({ chatSettings: { promptSuggestions: true, autoArchiveDays: 14 } })
    const html = render()
    expect(html).toContain('多久没有活跃')
    expect(html.match(/ 天</g)).toHaveLength(5)
    expect(html).toMatch(/aria-checked="true"[^>]*>14 天</)
  })
})
