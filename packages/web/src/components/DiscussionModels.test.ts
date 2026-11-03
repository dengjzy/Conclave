import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Discussion, type ChatCatalog } from '@conclave/protocol'
import { useAgentCatalogs } from '../agent-models'
import { DiscussionDraft } from './DiscussionDraft'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})
vi.mock('../agent-models', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agent-models')>(),
  useAgentCatalogs: vi.fn()
}))
vi.mock('../installed-agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('../installed-agents')>(),
  useInstalledAgents: () => ['codex', 'opencode']
}))

const catalog: ChatCatalog = { models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', description: null, efforts: ['low'], isDefault: true }] }

beforeEach(() => { vi.mocked(useAgentCatalogs).mockReturnValue({ codex: catalog, opencode: null }) })

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
})
