import { describe, expect, it } from 'vitest'
import { AgentProfile, type ChatCatalog, type Conversation, type Environment } from '@conclave/protocol'
import { delegationAgent, delegationAgents, delegationInstruction, delegationReadOnly, delegationRoleFields, directDelegationAllowed, directDelegationTarget } from './delegation-choice'

const parent: Conversation = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Parent', titleLocked: false, agent: 'claude',
  workspacePath: '/workspace', projectPaths: ['/project'], managedWorkspace: false, sessionId: null, createdAt: 0, updatedAt: 0
}
const catalog: ChatCatalog = { models: [
  { id: 'gpt-6-astra', label: 'Astra', description: null, efforts: ['low', 'high'], isDefault: true },
  { id: 'gpt-6-luna', label: 'Luna', description: null, efforts: ['low'], isDefault: false }
] }

describe('direct delegation choices', () => {
  it('uses the displayed concrete default without requiring a saved role or an extra click', () => {
    expect(directDelegationTarget(parent, 'codex', 'readOnly', catalog, {}, null)).toEqual({ agent: 'codex', model: 'gpt-6-astra', capability: 'readOnly', modelProvider: null })
    expect(directDelegationTarget(parent, 'codex', 'develop', catalog, { model: 'gpt-6-luna', effort: 'high' }, null)).toEqual({ agent: 'codex', model: 'gpt-6-luna', capability: 'develop', modelProvider: null })
    expect(directDelegationTarget(parent, 'codex', 'readOnly', catalog, { model: 'gpt-6-astra', effort: 'low' }, 'provider')).toMatchObject({ model: 'gpt-6-astra', effort: 'low', modelProvider: 'provider' })
  })

  it('never upgrades a read-only parent and refuses tools lacking native read-only support', () => {
    for (const patch of [{ workspaceReadOnly: true }, { planOnly: true }, { chatOptions: { permissionMode: 'plan', model: null, effort: null } }, { chatOptions: { permissionMode: 'readOnly', model: null, effort: null } }]) {
      const conversation = { ...parent, ...patch }
      expect(delegationReadOnly(conversation)).toBe(true)
      expect(directDelegationTarget(conversation, 'codex', 'develop', catalog, {}, null)?.capability).toBe('readOnly')
      expect(directDelegationTarget(conversation, 'antigravity', 'develop', null, {}, null)).toBeNull()
    }
    expect(directDelegationTarget(parent, 'antigravity', 'develop', null, {}, null)?.capability).toBe('develop')
  })

  it('waits for catalogs and refuses retired explicit models instead of silently switching', () => {
    expect(directDelegationTarget(parent, 'codex', 'readOnly', undefined, {}, null)).toBeNull()
    expect(directDelegationTarget(parent, 'codex', 'readOnly', catalog, { model: 'retired' }, null)).toBeNull()
    expect(directDelegationTarget(parent, null, 'readOnly', catalog, {}, null)).toBeNull()
  })

  it('requires the new core feature and preserves saved-role call restrictions', () => {
    expect(directDelegationAllowed(parent, ['agent-profiles'])).toBe(false)
    expect(directDelegationAllowed(parent, ['agent-profiles', 'direct-agent-calls'])).toBe(true)
    const profile = AgentProfile.parse({ id: parent.id, name: 'Coordinator', agent: 'claude', archivedAt: null, createdAt: 0, updatedAt: 0 })
    expect(directDelegationAllowed({ ...parent, profile }, ['direct-agent-calls'])).toBe(false)
  })

  it('offers detected enabled executables without discovery fallbacks', () => {
    const environment: Environment = { searchPath: [], checkedAt: 0, checks: [
      { tool: 'codex', status: 'ok', path: '/bin/codex', version: '1', signedIn: true },
      { tool: 'claude', status: 'missing', path: null, version: null, signedIn: null },
      { tool: 'pi', status: 'unknown', path: '/bin/pi', version: 'old', signedIn: true, problem: 'incompatible-version' }
    ] }
    expect(delegationAgents(environment, ['codex', 'claude', 'pi'])).toEqual(['codex'])
    expect(delegationAgents(environment, ['claude'])).toEqual([])
    expect(delegationAgents(null, ['codex'])).toEqual([])
  })

  it('does not silently change an explicitly selected tool when it disappears', () => {
    expect(delegationAgent(['codex', 'claude'], 'codex')).toBe('codex')
    const unavailable = delegationAgent(['claude'], 'codex')
    expect(unavailable).toBeNull()
    expect(directDelegationTarget(parent, unavailable, 'readOnly', catalog, { model: 'gpt-6-astra' }, 'provider')).toBeNull()
    expect(delegationAgent(['claude'], null)).toBe('claude')
  })

  it('previews exactly the explicit handoff and saves only reusable execution configuration', () => {
    expect(delegationInstruction('  Review the patch  ', '  Check src/parser.ts; return evidence.  ')).toBe('Review the patch\n\nCheck src/parser.ts; return evidence.')
    const target = directDelegationTarget(parent, 'codex', 'readOnly', catalog, {}, null)!
    expect(delegationRoleFields(target, '  Reviewer  ')).toEqual({ ...target, name: 'Reviewer' })
    expect(delegationRoleFields(target, 'Reviewer')).not.toHaveProperty('instructions')
    expect(delegationRoleFields(target, 'Reviewer')).not.toHaveProperty('callableProfiles')
  })
})
