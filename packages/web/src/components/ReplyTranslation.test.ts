import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { ChatItem, Conversation, createRpcClient, type RpcConnection } from '@conclave/protocol'
import { useChat } from '../chat-state'
import { useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { translationKey, useTranslations } from '../translation'
import { ConversationChat } from './ConversationChat'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
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
const conversation = Conversation.parse({
  id, title: '会话', titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [], managedWorkspace: false, sessionId: 's', createdAt: 0, updatedAt: 0, chat: { turn: 'idle' }
})
const base = { stageId: 'stage', revision: 1 }
const reply = 'I updated the local plan and moved the third-party sync out of the first phase, as agreed with the team.'
const items: ChatItem[] = [
  ChatItem.parse({ ...base, at: 1000, id: 'user', kind: 'user', text: '改一下计划' }),
  ChatItem.parse({ ...base, at: 2000, id: 'edit', kind: 'tool', name: 'Edit', title: 'docs/plan.md', input: null, status: 'done', output: null,
    diffs: [{ path: 'docs/plan.md', change: 'update', patch: '@@ -1 +1 @@\n-old\n+new\n' }] }),
  ChatItem.parse({ ...base, at: 3000, id: 'reply', kind: 'assistant', text: reply, streaming: false }),
  ChatItem.parse({ ...base, at: 4000, id: 'turn', kind: 'turn', state: 'completed', error: null, durationMs: 3000 })
]
const render = () => renderToStaticMarkup(createElement(ConversationChat, { conversation }))

beforeEach(() => {
  const client = createRpcClient(() => {})
  const rpc: RpcConnection = { ...client, features: ['translate'], close: () => {}, closed: new Promise(() => {}) }
  useCore.setState({ ...useCore.getInitialState(), connection: 'connected', rpc, conversations: { [id]: conversation } }, true)
  useChat.setState({ [id]: { items, before: null } }, true)
  useTranslations.setState({ results: {}, original: {} })
  usePreferences.setState({ translateTo: 'zh-CN', autoTranslate: false, quickModels: {}, foldTurns: true })
})

describe('translating a reply whose turn changed files', () => {
  it('offers it on the change card, which carries the reply\'s actions', () => {
    const html = render()
    expect(html).toContain('修改了 1 个文件')
    expect(html.match(/class="copy-button chat-translate"/g)).toHaveLength(1)
  })

  it('shows the translation in the reply, and copies it from the card', () => {
    const key = translationKey(id, 'item:stage/reply', 'zh-CN', '')
    useTranslations.setState({ results: { [key]: { state: 'done', text: '我更新了本地计划，把三方同步移出了一期。', model: 'haiku' } }, original: {} })
    const html = render()
    expect(html).toContain('我更新了本地计划')
    expect(html).not.toContain('I updated the local plan')
    expect(html).toContain('复制译文')
  })
})
