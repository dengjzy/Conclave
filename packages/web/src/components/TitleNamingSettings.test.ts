import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { createRpcClient, type RpcConnection, type TitleNaming } from '@conclave/protocol'
import { useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { TitleNamingSettings } from './TitleNamingSettings'

const controls = vi.hoisted(() => ({ select: (_mode: TitleNaming) => {} }))
vi.mock('./SettingsControls', async (original) => {
  const actual = await original<typeof import('./SettingsControls')>()
  return { ...actual, Segmented: (props: Parameters<typeof actual.Segmented<TitleNaming>>[0]) => {
    controls.select = props.onChange
    return createElement(actual.Segmented<TitleNaming>, props)
  } }
})
vi.mock('zustand', async (original) => {
  const actual = await original<typeof import('zustand')>()
  return { ...actual, create: <T>() => (initializer: StateCreator<T>) => {
    const store = actual.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
const render = () => renderToStaticMarkup(createElement(TitleNamingSettings))
beforeEach(() => { useCore.setState(useCore.getInitialState(), true); usePreferences.setState({ quickModels: {} }) })

describe('title naming settings', () => {
  it('is hidden for older cores', () => {
    useCore.setState({ chatSettings: { promptSuggestions: true } })
    expect(render()).toBe('')
  })

  it.each(['off', 'first', 'latest'] as const)('shows %s selected and explains usage and manual priority', (mode) => {
    useCore.setState({ chatSettings: { promptSuggestions: true, titleNaming: mode } })
    const html = render()
    expect(html).toContain('会话标题命名')
    expect(html).toContain('手动重命名优先')
    expect(html).toContain('计入少量用量')
    const label = { off: '关闭', first: '首轮总结', latest: '每轮更新' }[mode]
    expect(html).toContain(`aria-checked="true">${label}`)
  })

  it('saves the chosen mode and model choices to core', () => {
    const sent: unknown[] = []
    const client = createRpcClient((frame) => sent.push(JSON.parse(frame)))
    const rpc: RpcConnection = { ...client, features: [], close: () => {}, closed: new Promise(() => {}) }
    useCore.setState({ rpc, chatSettings: { promptSuggestions: true, titleNaming: 'off' } })
    usePreferences.setState({ quickModels: { claude: 'haiku', codex: 'gpt-6-luna' } })
    render()
    controls.select('latest')
    expect(sent[0]).toMatchObject({ method: 'system.setChatSettings', params: { titleNaming: 'latest', titleModels: { claude: 'haiku', codex: 'gpt-6-luna' } } })
  })
})
