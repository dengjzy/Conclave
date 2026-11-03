import { describe, expect, it, vi } from 'vitest'
import { AgentCall, RpcRequest, createRpcClient, type RpcConnection } from '@conclave/protocol'
import { agentCallForResult, agentCallsFeed } from './agent-calls'

const call = AgentCall.parse({ result: null, error: null, delivered: false,
  id: '11111111-1111-4111-8111-111111111111', parentId: '22222222-2222-4222-8222-222222222222', conversationId: '33333333-3333-4333-8333-333333333333',
  profile: { id: '44444444-4444-4444-8444-444444444444', name: '审查员', agent: 'codex', archivedAt: null, createdAt: 0, updatedAt: 0 },
  instruction: 'Review', permissionMode: 'readOnly', readOnly: true, state: 'queued', createdAt: 15, updatedAt: 15
})
function connection() {
  const sent: Array<ReturnType<typeof RpcRequest.parse>> = []
  const client = createRpcClient((frame) => sent.push(RpcRequest.parse(JSON.parse(frame))))
  const rpc: RpcConnection = { ...client, features: ['agent-profiles'], close() {}, closed: new Promise(() => {}) }
  return { rpc, sent, reply: (index: number, result: unknown) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[index]?.id, result })), notify: (next: AgentCall) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', method: 'agentCalls.changed', params: { call: next } })) }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('delegation live feed', () => {
  it('records a live dispatch, but not calls loaded from history', async () => {
    const { rpc, reply, notify } = connection()
    const feed = agentCallsFeed(rpc, call.parentId)
    const close = feed.subscribe(() => {})
    reply(0, [call])
    await settle()
    expect(feed.getSnapshot().dispatched.size).toBe(0)
    notify(call)
    expect(feed.getSnapshot().dispatched.size).toBe(0)
    const fresh = { ...call, id: '66666666-6666-4666-8666-666666666666', updatedAt: 16 }
    notify(fresh)
    expect(feed.getSnapshot().dispatched.has(fresh.id)).toBe(true)
    close()
    expect(feed.getSnapshot().dispatched.size).toBe(0)
  })

  it('does not restart a dispatch pulse when a queued call is reported again', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10000)
    try {
      const { rpc, notify } = connection()
      const feed = agentCallsFeed(rpc, call.parentId)
      const close = feed.subscribe(() => {})
      notify({ ...call, updatedAt: 16 })
      expect(feed.getSnapshot().dispatched.get(call.id)).toBe(10000)
      now.mockReturnValue(10500)
      notify({ ...call, updatedAt: 17 })
      expect(feed.getSnapshot().dispatched.get(call.id)).toBe(10000)
      close()
    } finally { now.mockRestore() }
  })

  it('links each delivered result to its exact call', () => {
    const another = { ...call, id: '66666666-6666-4666-8666-666666666666' }
    expect(agentCallForResult({ kind: 'user', id: `u:agent-result:${another.id}` }, [call, another])).toBe(another)
    expect(agentCallForResult({ kind: 'assistant', id: `u:agent-result:${another.id}` }, [another])).toBeUndefined()
    expect(agentCallForResult({ kind: 'user', id: `u:agent-result:${another.id}` }, null)).toBeUndefined()
    expect(agentCallForResult({ kind: 'user', id: 'u:agent-result:bad' }, [another])).toBeUndefined()
  })
  it('shares chat and inspector subscriptions, buffers events during list loading and detaches after the last reader', async () => {
    const { rpc, sent, reply, notify } = connection()
    const feed = agentCallsFeed(rpc, call.parentId)
    expect(agentCallsFeed(rpc, call.parentId)).toBe(feed)
    const changed = vi.fn()
    const stopChat = feed.subscribe(changed)
    const stopInspector = feed.subscribe(() => {})
    expect(sent).toHaveLength(1)
    notify({ ...call, state: 'running' })
    reply(0, [call])
    await settle()
    expect(feed.getSnapshot().calls).toMatchObject([{ state: 'running' }])
    notify({ ...call, parentId: '55555555-5555-4555-8555-555555555555', state: 'failed' })
    expect(feed.getSnapshot().calls?.[0]?.state).toBe('running')
    stopChat()
    notify({ ...call, state: 'completed', result: 'Ready' })
    expect(feed.getSnapshot().calls).toMatchObject([{ state: 'completed', result: 'Ready' }])
    stopInspector()
    const snapshot = feed.getSnapshot()
    notify({ ...call, state: 'cancelled' })
    expect(feed.getSnapshot()).toBe(snapshot)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('ignores an abandoned list reply and refreshes on reopen; a different connection starts empty', async () => {
    const { rpc, sent, reply } = connection()
    const feed = agentCallsFeed(rpc, call.parentId)
    const stop = feed.subscribe(() => {})
    stop()
    reply(0, [call])
    await settle()
    expect(feed.getSnapshot().calls).toBeNull()
    const close = feed.subscribe(() => {})
    expect(sent).toHaveLength(2)
    reply(1, [{ ...call, state: 'completed' }])
    await settle()
    expect(feed.getSnapshot().calls?.[0]?.state).toBe('completed')
    expect(agentCallsFeed(connection().rpc, call.parentId).getSnapshot().calls).toBeNull()
    close()
  })
})
