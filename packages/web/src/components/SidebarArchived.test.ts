import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { Conversation, createRpcClient, Discussion, type RpcConnection } from '@conclave/protocol'
import { useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { ConversationList } from './ConversationList'
import { SidebarDiscussions } from './SidebarDiscussions'

// Read the live store instead of Zustand's fixed SSR hydration snapshot.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const chat = (n: number, title: string, archivedAt: number | null) => Conversation.parse({
  id: id(n), title, titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [], managedWorkspace: false,
  sessionId: null, createdAt: n, updatedAt: n, archivedAt
})
const discussion = (n: number, title: string, archivedAt: number | null) => Discussion.parse({
  id: id(n), title, topic: title, projectPaths: [], members: [], chairId: id(99), maxRounds: 3, anonymous: false,
  state: 'done', step: null, round: 1, lastRound: 1, pinnedAt: null, archivedAt, createdAt: n, updatedAt: n
})

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  const client = createRpcClient(() => {})
  const rpc: RpcConnection = { ...client, features: ['discussions', 'discussion-archive', 'conversation-archive'], close: () => {}, closed: new Promise(() => {}) }
  useCore.setState({
    connection: 'connected', rpc,
    conversations: { [id(1)]: chat(1, '在用的会话', null), [id(2)]: chat(2, '归档的会话', 5) },
    discussions: { [id(3)]: discussion(3, '在用的群聊', null), [id(4)]: discussion(4, '归档的群聊', 5) }
  })
  usePreferences.setState({ showArchivedConversations: false, showArchivedDiscussions: false })
})

describe('archived in the sidebar', () => {
  it('keeps archived conversations and group chats out of sight until asked for', () => {
    const conversations = renderToStaticMarkup(createElement(ConversationList))
    const discussions = renderToStaticMarkup(createElement(SidebarDiscussions))
    expect(conversations).toContain('在用的会话')
    expect(conversations).not.toContain('已归档')
    expect(conversations).not.toContain('归档的会话')
    expect(discussions).toContain('在用的群聊')
    expect(discussions).not.toContain('归档的群聊')
    // Group chats offer the same view menu as conversations, where there is something to show.
    expect(discussions).toContain('aria-label="列表选项"')
  })

  it('shows them, opened, at the end of each list once asked for', () => {
    usePreferences.setState({ showArchivedConversations: true, showArchivedDiscussions: true })
    expect(renderToStaticMarkup(createElement(ConversationList))).toMatch(/已归档.*归档的会话/s)
    expect(renderToStaticMarkup(createElement(SidebarDiscussions))).toMatch(/已归档.*归档的群聊/s)
  })

  it('offers no view menu for group chats when none is archived', () => {
    useCore.setState({ discussions: { [id(3)]: discussion(3, '在用的群聊', null) } })
    expect(renderToStaticMarkup(createElement(SidebarDiscussions))).not.toContain('列表选项')
  })
})
