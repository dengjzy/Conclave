import { describe, expect, it } from 'vitest'
import { ChatItems } from './chat-items'
import { ConclaveRequests } from './conclave-requests'
import { parseChatRecord } from './chat-log'

describe('ConclaveRequests', () => {
  it('shows a question as an approval, answers it, and cancels what is left when the agent goes', () => {
    const items = new ChatItems('stage-1')
    const requests = new ConclaveRequests(items)
    requests.apply({ dir: 'ask', at: 1, requestId: 'conclave:browser-host:1', ask: { kind: 'browser-host', host: 'example.com', url: 'https://example.com/' } })
    requests.apply({ dir: 'ask', at: 2, requestId: 'conclave:browser-host:2', ask: { kind: 'browser-host', host: 'other.com', url: 'https://other.com/' } })
    expect(requests.pending).toBe(2)
    expect(items.list()).toMatchObject([
      { kind: 'approval', requestId: 'conclave:browser-host:1', tool: 'browser_host', title: 'example.com', detail: 'https://example.com/', decisions: ['allow', 'allowForSession', 'deny'], resolution: null },
      { kind: 'approval', requestId: 'conclave:browser-host:2' }
    ])
    requests.apply({ dir: 'answer', at: 3, requestId: 'conclave:browser-host:1', resolution: 'allowedForSession' })
    expect(requests.pending).toBe(1)
    requests.cancelAll(4)
    expect(requests.pending).toBe(0)
    expect(items.list().map((item) => item.kind === 'approval' && item.resolution)).toEqual(['allowedForSession', 'cancelled'])
  })

  // Read back from the log as a restarted core reads it: both kinds, so neither card is lost.
  it('reads both kinds of question back from the chat log', () => {
    const browser = { dir: 'ask', at: 1, requestId: 'conclave:browser-host:1', ask: { kind: 'browser-host', host: 'example.com', url: 'https://example.com/' } }
    const terminal = { dir: 'ask', at: 2, requestId: 'conclave:terminal-run:1', ask: { kind: 'terminal-run', command: 'pnpm test', cwd: '/work' } }
    expect(parseChatRecord(JSON.stringify(browser))).toEqual(browser)
    expect(parseChatRecord(JSON.stringify(terminal))).toEqual(terminal)
  })
})
