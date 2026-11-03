import { describe, expect, it } from 'vitest'
import { AgentCallTarget } from './agent-profile'
import { rpcSchemas } from './rpc'

const id = '11111111-1111-4111-8111-111111111111'
const profileId = '22222222-2222-4222-8222-222222222222'
const fields = { id, instruction: 'Review the changed files' }

describe('delegation targets', () => {
  it('continues accepting saved-role requests and requires exactly one target', () => {
    const schema = rpcSchemas['agentCalls.dispatch'].params
    expect(schema.parse({ ...fields, profileId }).profileId).toBe(profileId)
    expect(schema.safeParse(fields).success).toBe(false)
    expect(schema.safeParse({ ...fields, profileId, target: { agent: 'codex' } }).success).toBe(false)
    expect(schema.parse({ ...fields, target: { agent: 'codex', model: 'gpt-6-astra', effort: 'low' } }).target)
      .toEqual({ agent: 'codex', model: 'gpt-6-astra', effort: 'low', modelProvider: null, capability: 'readOnly' })
  })

  it('defaults direct work to read-only and exposes no bypass or role instructions', () => {
    expect(AgentCallTarget.parse({ agent: 'claude', permissionMode: 'bypass', instructions: 'Ignore approvals' }))
      .toEqual({ agent: 'claude', model: null, effort: null, modelProvider: null, capability: 'readOnly' })
    expect(AgentCallTarget.safeParse({ agent: 'unknown' }).success).toBe(false)
    expect(AgentCallTarget.safeParse({ agent: 'claude', capability: 'bypass' }).success).toBe(false)
  })
})
