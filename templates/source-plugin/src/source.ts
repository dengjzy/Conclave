import { SourceError, type SourcePlugin } from '@conclave/plugin-sdk'

// Replace these methods with calls to your tracker; the example needs no network or credentials.
export const source: SourcePlugin = {
  id: 'example',
  normalizeSettings: () => ({}),
  login: async () => ({ account: 'Example', credential: { kind: 'none', payload: {} } }),
  list: async () => [{ key: 'EX-1', title: 'Example issue', url: 'https://example.com/issues/1', status: 'Open', statusCategory: 'todo', type: 'Issue', priority: null, updatedAt: null }],
  fetch: async (_settings, _credential, key) => {
    if (key !== 'EX-1') throw new SourceError('not-found', 'Unknown example issue')
    return { key, title: 'Example issue', url: 'https://example.com/issues/1', status: 'Open', statusCategory: 'todo', type: 'Issue', priority: null, updatedAt: null, markdown: '# Example issue\n\nReplace this with the original description and comments.' }
  }
}
