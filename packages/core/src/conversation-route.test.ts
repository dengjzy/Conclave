import { describe, expect, it } from 'vitest'
import type { ConversationStage, ModelProvider } from '@conclave/protocol'
import { decideRoute, providerRoute, sameRoute } from './conversation-route'

const provider: ModelProvider = {
  id: 'gw', name: 'Gateway', preset: 'custom', anthropic: { baseUrl: 'https://gw.example.com', auth: 'auth_token', env: {} }, openai: null,
  models: [{ id: 'm', label: null, contextWindow: null, maxOutput: null, efforts: [] }], defaultModel: 'm', smallModel: 'm',
  agents: ['claude', 'opencode'], hasKey: true, revision: 1, createdAt: 0, updatedAt: 0
}
const resolved = { provider, apiKey: 'k' }
const route = providerRoute(provider, { wire: 'anthropic', baseUrl: 'https://gw.example.com', anthropic: provider.anthropic })
const stage = (onProvider: boolean): ConversationStage => ({
  id: '00000000-0000-4000-8000-000000000001', conversationId: '00000000-0000-4000-8000-000000000002', agent: 'claude',
  providerSessionId: 's', sessionId: null, receivedSequence: 0, startedAt: 0, endedAt: 1, exitCode: 0, route: onProvider ? route : null
})

describe('decideRoute', () => {
  it('runs an agent the provider serves on it, and one it does not on its own account', () => {
    expect(decideRoute(null, 'claude', null, null)).toEqual({ kind: 'own', unsupported: false })
    expect(decideRoute('gw', 'claude', null, resolved)).toMatchObject({ kind: 'provider', apiKey: 'k', route: { providerId: 'gw', key: 'gw|anthropic|https://gw.example.com' } })
    expect(decideRoute('gw', 'codex', null, resolved)).toEqual({ kind: 'own', unsupported: true })
  })

  it('keeps an agent on whatever it ran on here, refusing rather than moving it to its own account', () => {
    expect(decideRoute('gw', 'claude', stage(false), resolved)).toEqual({ kind: 'own', unsupported: true })
    expect(decideRoute('gw', 'claude', stage(true), null).kind).toBe('unavailable')
    expect(decideRoute('gw', 'claude', stage(true), { ...resolved, provider: { ...provider, agents: ['opencode'] } }).kind).toBe('unavailable')
    expect(decideRoute('gw', 'claude', null, null).kind).toBe('unavailable')
  })

  it('tells routes apart by provider, wire and address only', () => {
    expect(sameRoute(route, { ...route, models: [] })).toBe(true)
    expect(sameRoute(route, null)).toBe(false)
    expect(sameRoute(undefined, null)).toBe(true)
  })
})
