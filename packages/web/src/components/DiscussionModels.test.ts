import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { createRpcClient, Discussion, type ChatCatalog, type RpcConnection } from '@conclave/protocol'
import { useAgentCatalogs } from '../agent-models'
import { DiscussionDraft } from './DiscussionDraft'
import { useCore } from '../core-store'
import { DiscussionView } from './DiscussionView'
import { useDiscussionPosts } from '../discussions'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})
vi.mock('../agent-models', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agent-models')>(),
  useAgentCatalogs: vi.fn()
}))
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
vi.mock('../installed-agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('../installed-agents')>(),
  useInstalledAgents: () => ['codex', 'opencode']
}))

const catalog: ChatCatalog = { models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', description: null, efforts: ['low'], isDefault: true }] }

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  vi.mocked(useAgentCatalogs).mockReturnValue({ codex: catalog, opencode: null })
})

describe('group model display', () => {
  it('shows the concrete default that will be submitted and names the member consistently', () => {
    const html = renderToStaticMarkup(createElement(DiscussionDraft, { from: null }))
    expect(html).toContain('模型：GPT-6-Astra')
    expect(html).toContain('value="Codex · gpt-6-astra"')
  })

  it('shows loading or an unspecified default rather than inventing a concrete model', () => {
    vi.mocked(useAgentCatalogs).mockReturnValue({ opencode: null })
    const html = renderToStaticMarkup(createElement(DiscussionDraft, { from: null }))
    expect(html).toContain('正在读取模型…')
    expect(html).not.toContain('GPT-6-Astra')
    expect(html).toContain('默认模型')
  })

  it('keeps a copied unsupported selection visible and asks for another model', () => {
    const from = Discussion.parse({
      id: '11111111-1111-4111-8111-111111111111', title: 'test', topic: 'test', projectPaths: [],
      chairId: '22222222-2222-4222-8222-222222222222', maxRounds: 1, anonymous: false,
      state: 'done', step: null, round: 1, lastRound: 1, pinnedAt: null, createdAt: 0, updatedAt: 0,
      members: [
        { id: '22222222-2222-4222-8222-222222222222', conversationId: '33333333-3333-4333-8333-333333333333', agent: 'codex', model: 'gpt-6.1-terra', effort: null, name: 'Codex', role: '' },
        { id: '44444444-4444-4444-8444-444444444444', conversationId: '55555555-5555-4555-8555-555555555555', agent: 'opencode', model: null, effort: null, name: 'OpenCode', role: '' }
      ]
    })
    const html = renderToStaticMarkup(createElement(DiscussionDraft, { from }))
    expect(html).toContain('模型：gpt-6.1-terra')
    expect(html).toContain('gpt-6.1-terra 不在当前模型列表中，请重新选择。')
    expect(html).not.toContain('模型：GPT-6-Astra')
  })

  it('shows the persisted summary choice and keeps older services on the summary path', () => {
    const client = createRpcClient(() => {})
    const rpc: RpcConnection = { ...client, features: ['discussions', 'discussion-summary-choice', 'discussion-topics'], close: () => {}, closed: new Promise(() => {}) }
    useCore.setState({ rpc })
    const from = Discussion.parse({
      id: '11111111-1111-4111-8111-111111111111', title: 'Answers only', topic: 'test', projectPaths: [],
      chairId: '22222222-2222-4222-8222-222222222222', maxRounds: 1, summarize: false, anonymous: false,
      state: 'done', step: 'round', round: 1, lastRound: 1, pinnedAt: null, createdAt: 0, updatedAt: 0,
      members: [
        { id: '22222222-2222-4222-8222-222222222222', conversationId: '33333333-3333-4333-8333-333333333333', agent: 'codex', model: null, effort: null, name: 'Codex', role: '' },
        { id: '44444444-4444-4444-8444-444444444444', conversationId: '55555555-5555-4555-8555-555555555555', agent: 'opencode', model: null, effort: null, name: 'OpenCode', role: '' }
      ]
    })
    const render = () => renderToStaticMarkup(createElement(DiscussionDraft, { from }))
    const html = render()
    expect(html).toContain('主持 Agent 总结')
    expect(html).toContain('群聊成员以只读方式工作')
    expect(html).not.toContain('type="radio"')
    expect(html).not.toContain('checked=""')
    useCore.setState({ discussions: { [from.id]: from } })
    useDiscussionPosts.setState({ [from.id]: [] }, true)
    const view = renderToStaticMarkup(createElement(DiscussionView, { id: from.id }))
    expect(view).toContain('不另生成总结')
    expect(view).not.toContain('大家再看一遍彼此的观点，然后重新总结')
    expect(view).not.toContain('大家重新各自作答、讨论、总结')
    useCore.setState({ rpc: { ...rpc, features: ['discussions'] } })
    const legacy = render()
    expect(legacy).toContain('当前 Core 不支持关闭总结')
    expect(legacy).toContain('type="radio"')
    expect(legacy).toContain('type="checkbox" disabled="" checked=""')
  })
})
