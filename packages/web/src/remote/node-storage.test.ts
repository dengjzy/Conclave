import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let stored: Map<string, string>
beforeEach(() => {
  stored = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
    removeItem: (key: string) => { stored.delete(key) }
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
async function open(node: string | null) {
  vi.resetModules()
  vi.stubGlobal('location', { search: node ? `?node=${node}` : '' })
  return import('./node-storage')
}

describe('node-scoped application storage', () => {
  it('preserves existing local keys without migrating local writes into remote nodes', async () => {
    stored.set('conclave.unsaved-edits', 'local edit')
    expect((await open(null)).nodeStorage.getItem('conclave.unsaved-edits')).toBe('local edit')
    expect((await open('node-a')).nodeStorage.getItem('conclave.unsaved-edits')).toBeNull()
    expect((await open('local')).nodeStorage.getItem('conclave.unsaved-edits')).toBe('local edit')
  })
  it('isolates identical object IDs across nodes and restores each node on return', async () => {
    const a = await open('node-a')
    a.nodeStorage.setItem('conclave.composer-drafts', 'draft A')
    const b = await open('node-b')
    expect(b.nodeStorage.getItem('conclave.composer-drafts')).toBeNull()
    b.nodeStorage.setItem('conclave.composer-drafts', 'draft B')
    expect(a.nodeStorage.getItem('conclave.composer-drafts')).toBe('draft A')
    expect((await open('node-a')).nodeStorage.getItem('conclave.composer-drafts')).toBe('draft A')
    expect((await open('node-b')).nodeStorage.getItem('conclave.composer-drafts')).toBe('draft B')
  })
  it('keeps credentials and saved-node library outside application storage', async () => {
    stored.set('conclave-mobile-hosts-v3', 'node library')
    const scope = await open('node-a')
    scope.nodeStorage.removeItem('conclave.composer-drafts')
    expect(stored.get('conclave-mobile-hosts-v3')).toBe('node library')
    expect(scope.nodeStorageKey('conclave.preferences')).not.toBe('conclave.preferences')
  })
  it('does not restore another node’s automatic task edits or pending initial message', async () => {
    await open('node-a')
    const edits = await import('../unsaved-edits')
    const messages = await import('../initial-messages')
    edits.saveTaskText('same-id', 'details', 'only node A')
    messages.keepInitialMessage('same-id', 'message for A', [])
    await open('node-b')
    expect((await import('../unsaved-edits')).unsavedTaskText('same-id', 'details')).toBeUndefined()
    expect((await import('../initial-messages')).useInitialMessages.getState()['same-id']).toBeUndefined()
    await open('node-a')
    expect((await import('../unsaved-edits')).unsavedTaskText('same-id', 'details')).toBe('only node A')
    expect((await import('../initial-messages')).useInitialMessages.getState()['same-id']).toMatchObject({ text: 'message for A', phase: 'failed' })
  })
})
