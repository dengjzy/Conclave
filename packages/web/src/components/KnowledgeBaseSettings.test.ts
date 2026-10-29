import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { createRpcClient, type RpcConnection } from '@conclave/protocol'
import { useCore } from '../core-store'
import { KnowledgeBaseSettings } from './KnowledgeBaseSettings'

// Read the live store instead of Zustand's fixed SSR hydration snapshot.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
vi.mock('../desktop-bridge', () => ({ canPickFolder: () => true, pickFolder: vi.fn() }))

function connect(features: string[] = ['knowledge-base', 'knowledge-base-kind', 'skills-library']): void {
  const client = createRpcClient(() => {})
  const rpc: RpcConnection = { ...client, features, close: () => {}, closed: new Promise(() => {}) }
  useCore.setState({ connection: 'connected', rpc, chatSettings: { promptSuggestions: true, knowledgeBase: null } })
}

const render = () => renderToStaticMarkup(createElement(KnowledgeBaseSettings))
beforeEach(() => useCore.setState(useCore.getInitialState(), true))

describe('knowledge base settings', () => {
  it('defaults new users to Markdown folders without an Obsidian installation', () => {
    connect()
    const html = render()
    expect(html).toContain('aria-checked="true">Markdown 文件夹')
    expect(html).toContain('选择 Markdown 文件夹…')
    expect(html).toContain('相对路径链接')
    expect(html).not.toContain('Obsidian 技能')
  })

  it('keeps legacy vaults in Obsidian mode with the skill recommendation', () => {
    connect()
    useCore.setState({ chatSettings: { promptSuggestions: true, knowledgeBase: { path: '/notes/vault', write: true } } })
    const html = render()
    expect(html).toContain('aria-checked="true">Obsidian')
    expect(html).toContain('选择其他文件夹…')
    expect(html).toContain('Obsidian 技能')
    expect(html).toContain('/notes/vault')
  })

  it('shows Markdown conventions for an existing read-only folder', () => {
    connect()
    useCore.setState({ chatSettings: { promptSuggestions: true, knowledgeBase: { path: '/notes/plain', write: false, kind: 'markdown' } } })
    const html = render()
    expect(html).toContain('aria-checked="true">Markdown 文件夹')
    expect(html).toContain('/notes/plain')
    expect(html).not.toContain('Obsidian 技能')
    expect(html).not.toContain('checked=""')
  })

  it('offers only the legacy interface on an older core', () => {
    connect(['knowledge-base', 'skills-library'])
    const html = render()
    expect(html).not.toContain('radiogroup')
    expect(html).not.toContain('选择 Markdown 文件夹')
    expect(html).toContain('选择其他文件夹…')
  })
})
