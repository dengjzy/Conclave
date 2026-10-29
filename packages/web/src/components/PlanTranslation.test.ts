import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { Conversation, createRpcClient, type ChatItem, type RpcConnection } from '@conclave/protocol'
import { itemKey } from '../chat-state'
import { useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { translationKey, useTranslations } from '../translation'
import { ChatPlanView } from './ChatPlan'

// The chat's markdown reaches modules that read the window as they load.
vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

// Read the live store instead of Zustand's fixed SSR hydration snapshot.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

const id = '00000001-0000-4000-8000-000000000000'
const plan: Extract<ChatItem, { kind: 'approval' }> = {
  id: 'p:1', stageId: 'stage', revision: 1, at: 0, kind: 'approval', requestId: '1', tool: 'ExitPlanMode', title: 'Plan', toolItemId: null,
  detail: '## Plan\n\nRename the store, then update every caller and run the tests before shipping it.', decisions: ['allow', 'deny'], resolution: null
}
const render = () => renderToStaticMarkup(createElement(ChatPlanView, { conversationId: id, plans: [plan], selected: null, onSelect: () => {} }))

function connect(features: string[]): void {
  const client = createRpcClient(() => {})
  const rpc: RpcConnection = { ...client, features, close: () => {}, closed: new Promise(() => {}) }
  useCore.setState({ connection: 'connected', rpc, conversations: { [id]: Conversation.parse({
    id, title: '会话', titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [], managedWorkspace: false, sessionId: null, createdAt: 0, updatedAt: 0
  }) } })
}

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  useTranslations.setState({ results: {}, original: {} })
  usePreferences.setState({ translateTo: 'zh-CN', autoTranslate: false, quickModels: {} })
})

describe('translating a plan', () => {
  it('offers to translate a plan in another language, where core can', () => {
    connect(['translate'])
    expect(render()).toContain('翻译这份计划')
    connect([])
    expect(render()).not.toContain('chat-translate')
  })

  it('shows the translation, shared by key, with the original a click away', () => {
    connect(['translate'])
    const key = translationKey(id, `plan:${itemKey(plan)}`, 'zh-CN', '')
    useTranslations.setState({ results: { [key]: { state: 'done', text: '## 计划\n\n先重命名 store。', model: 'haiku' } }, original: {} })
    const html = render()
    expect(html).toContain('先重命名 store。')
    expect(html).not.toContain('Rename the store')
    expect(html).toContain('原文')
    useTranslations.setState({ original: { [key]: true } })
    expect(render()).toContain('Rename the store')
  })
})
