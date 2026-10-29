import { describe, expect, it } from 'vitest'
import { agentReadiness, agentSetupIdentity } from './agent-readiness'
import { EnvironmentCheck, environmentProblems, type Environment } from './environment'
import type { AgentKind } from './agent'
import { ModelProvider } from './model-provider'

const check = (agent: AgentKind, fields: Partial<EnvironmentCheck> = {}): Environment => ({ checks: [{ tool: agent, status: 'ok', version: '1.0.0', path: `/bin/${agent}`, signedIn: false, ...fields }], checkedAt: 0, searchPath: [] })
const provider = ModelProvider.parse({ id: 'test', name: 'Test', preset: 'custom', anthropic: { baseUrl: 'https://api.example.com', auth: 'api_key', env: {} }, openai: null, models: [{ id: 'model', label: null, contextWindow: null, maxOutput: null, efforts: [] }], defaultModel: 'model', smallModel: 'model', agents: ['claude', 'codex', 'opencode'], hasKey: true, revision: 0, createdAt: 0, updatedAt: 0 })

describe('agentReadiness', () => {
  it('waits for facts and does not offer installation for an agent an older core never reports', () => {
    expect(agentReadiness('claude', null, [], [])).toEqual({ state: 'checking' })
    expect(agentReadiness('codex', check('claude'), [], [])).toEqual({ state: 'unsupported' })
  })

  it('distinguishes disabled, missing CLI, and a missing managed runtime', () => {
    expect(agentReadiness('claude', check('claude', { signedIn: true }), ['claude'], [provider])).toEqual({ state: 'disabled' })
    expect(agentReadiness('claude', check('claude', { status: 'missing' }), [], [provider])).toEqual({ state: 'missing' })
    const env = check('cursor', { status: 'missing' })
    env.detectedAgents = [{ id: 'cursor', name: 'Cursor', locations: [{ source: 'application', path: '/Cursor.app' }] }]
    expect(agentReadiness('cursor', env, [], [])).toEqual({ state: 'cli-missing' })
    expect(agentReadiness('antigravity', { ...check('antigravity', { status: 'missing' }), detectedAgents: [{ id: 'antigravity', name: 'Antigravity', locations: [{ source: 'application', path: '/Antigravity.app' }] }] }, [], [])).toEqual({ state: 'missing' })
  })

  it('does not let credentials bypass failed probes or incompatible releases', () => {
    for (const problem of ['probe-failed', 'incompatible-version'] as const) {
      expect(agentReadiness('claude', check('claude', { status: 'unknown', signedIn: true, problem }), [], [provider])).toEqual({ state: problem })
    }
    expect(agentReadiness('claude', check('claude', { status: 'unknown', version: '0.1.0' }), [], [provider])).toEqual({ state: 'needs-check' })
  })

  it('accepts native sign-in or a compatible provider with a key, without equating any provider with readiness', () => {
    expect(agentReadiness('claude', check('claude', { signedIn: true }), [], [provider])).toEqual({ state: 'ready', via: 'account' })
    expect(agentReadiness('claude', check('claude'), [], [provider])).toEqual({ state: 'ready', via: 'provider', provider })
    expect(agentReadiness('opencode', check('opencode', { signedIn: null }), [], [provider]).state).toBe('ready')
    expect(agentReadiness('codex', check('codex'), [], [provider]).state).toBe('needs-account')
    expect(agentReadiness('claude', check('claude'), [], [{ ...provider, hasKey: false }]).state).toBe('needs-account')
    expect(agentReadiness('claude', check('claude'), [], [{ ...provider, agents: [] }]).state).toBe('needs-account')
  })

  it('uses current provider test failures without imposing tests or trusting a result for an earlier edit', () => {
    const result = { ok: false, checks: [{ wire: 'anthropic' as const, model: 'model', ok: false, status: 401, message: 'Invalid API key', latencyMs: 1 }], at: 0 }
    const probes = { test: { revision: provider.revision, result } }
    expect(agentReadiness('claude', check('claude'), [], [provider], probes)).toEqual({ state: 'provider-failed', provider, message: 'Invalid API key' })
    expect(agentReadiness('claude', check('claude'), [], [{ ...provider, revision: 1 }], probes).state).toBe('ready')
    expect(agentReadiness('claude', check('claude', { signedIn: true }), [], [provider], probes)).toEqual({ state: 'ready', via: 'account' })
    expect(agentReadiness('claude', check('claude'), [], [provider, { ...provider, id: 'other' }], probes)).toMatchObject({ state: 'ready', via: 'provider', provider: { id: 'other' } })
  })

  it('keeps unknown native configuration separate from proven sign-out and first-use authorization', () => {
    expect(agentReadiness('claude', check('claude', { signedIn: null }), [], [])).toEqual({ state: 'unknown-auth' })
    expect(agentReadiness('opencode', check('opencode', { signedIn: null }), [], [])).toEqual({ state: 'unknown-auth' })
    expect(agentReadiness('opencode', check('opencode'), [], [])).toEqual({ state: 'needs-provider' })
    expect(agentReadiness('antigravity', check('antigravity'), [], [])).toEqual({ state: 'authorize-on-use' })
  })

  it('does not announce a global sign-in blocker when a provider is configured, while preserving Git blockers', () => {
    const environment = check('claude')
    expect(environmentProblems(environment, { providers: [provider], disabled: [] })).toEqual([])
    expect(environmentProblems(environment, { providers: [{ ...provider, hasKey: false }], disabled: [] })).toEqual([{ code: 'no-signed-in-agent' }])
    expect(environmentProblems({ checks: [{ tool: 'git', status: 'missing', path: null, version: null, signedIn: null }, ...environment.checks] }, { providers: [provider], disabled: [] })).toEqual([{ code: 'git-missing' }])
  })

  it('reads the new reason optionally and scopes user confirmation to a working installation', () => {
    expect(EnvironmentCheck.parse(check('claude').checks[0]).problem).toBeUndefined()
    expect(agentSetupIdentity('claude', check('claude'))).not.toBe(agentSetupIdentity('claude', check('claude', { version: '2.0.0' })))
    expect(agentSetupIdentity('claude', check('claude', { status: 'unknown' }))).toBeNull()
  })
})
