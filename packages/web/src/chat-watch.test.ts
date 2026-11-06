import { describe, expect, it } from 'vitest'
import { createRpcClient, type RpcConnection } from '@conclave/protocol'
import { retainChat } from './chat-watch'
import { useChat } from './chat-state'
function connection() {
  const sent: Array<{ id: number; method: string }> = []
  const client = createRpcClient((frame) => sent.push(JSON.parse(frame)))
  const rpc: RpcConnection = { ...client, features: [], close() {}, closed: new Promise(() => {}) }
  const answer = (index: number, result: unknown) => client.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[index]?.id, result }))
  return { rpc, sent, answer }
}
const tick = async () => { await Promise.resolve(); await Promise.resolve() }
describe('shared conversation watches', () => {
  it('keeps a transcript live when its worktree panel closes', async () => {
    const { rpc, sent, answer } = connection()
    const first = retainChat(rpc, 'chat-1'), second = retainChat(rpc, 'chat-1')
    expect(sent.map((frame) => frame.method)).toEqual(['conversations.watchChat'])
    answer(0, { items: [], before: null }); await tick()
    first()
    expect(useChat.getState()['chat-1']).toBeDefined()
    expect(sent).toHaveLength(1)
    second()
    expect(sent.at(-1)?.method).toBe('conversations.unwatchChat')
    expect(useChat.getState()['chat-1']).toBeUndefined()
    second()
    expect(sent).toHaveLength(2)
    answer(1, { ok: true })
  })
  it('ignores a late snapshot after the last consumer leaves', async () => {
    const { rpc, answer } = connection()
    retainChat(rpc, 'chat-2')()
    answer(0, { items: [], before: null }); answer(1, { ok: true }); await tick()
    expect(useChat.getState()['chat-2']).toBeUndefined()
  })
  it('does not let an old connection overwrite or drop a reconnected view', async () => {
    const old = connection(), next = connection()
    const releaseOld = retainChat(old.rpc, 'chat-3')
    const releaseNext = retainChat(next.rpc, 'chat-3')
    next.answer(0, { items: [], before: '00000000-0000-4000-8000-000000000001' }); await tick()
    old.answer(0, { items: [], before: null }); await tick()
    expect(useChat.getState()['chat-3']?.before).not.toBeNull()
    releaseOld()
    expect(useChat.getState()['chat-3']).toBeDefined()
    old.answer(1, { ok: true })
    releaseNext(); next.answer(1, { ok: true })
  })
})
