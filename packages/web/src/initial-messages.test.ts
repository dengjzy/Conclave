import { beforeEach, describe, expect, it } from 'vitest'
import { createRpcClient, RpcRequest, type ChatImage, type ChatReference, type Conversation, type RpcConnection } from '@conclave/protocol'
import { acknowledgeInitialMessage, keepInitialMessage, restoredInitialMessages, sendInitialMessage, useInitialMessages } from './initial-messages'
import { useCore } from './core-store'

const id = 'd964b86b-6a8c-4e23-9b79-dff4fdb4a3ad'
const image: ChatImage = { id: `${'a'.repeat(64)}.png`, width: 4, height: 3 }
const conversation: Conversation = { id, title: 'New', titleLocked: false, agent: 'cursor', workspacePath: '/workspace', projectPaths: [], managedWorkspace: true, sessionId: 'session', createdAt: 0, updatedAt: 0 }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function connection(features: RpcConnection['features'] = ['deferred-conversation-start']) {
  const sent: Array<ReturnType<typeof RpcRequest.parse>> = []
  const client = createRpcClient((frame) => sent.push(RpcRequest.parse(JSON.parse(frame))))
  const rpc: RpcConnection = { ...client, close() {}, closed: Promise.resolve(), features }
  const reply = (index: number, result: unknown) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[index]?.id, result }))
  const fail = (index: number) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[index]?.id, error: { code: -32000, message: 'startup failed' } }))
  rpc.on('conversations.changed', ({ conversation }) => useCore.setState((state) => ({ conversations: { ...state.conversations, [conversation.id]: conversation } })))
  useCore.setState({ rpc, conversations: { [id]: conversation } })
  const change = (conversation: Conversation) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', method: 'conversations.changed', params: { conversation } }))
  return { rpc, sent, reply, fail, change }
}

beforeEach(() => {
  useInitialMessages.setState({}, true)
  useCore.setState(useCore.getInitialState(), true)
})

describe('initial message delivery', () => {
  it('restores reference targets after a reload and delivers them separately from the native prompt', async () => {
    const { rpc, sent, reply } = connection(['deferred-conversation-start', 'chat-references'])
    const references: ChatReference[] = [{ start: 0, end: 6, target: { kind: 'file', path: '/workspace/src/a.ts', relative: 'src/a.ts' } }]
    keepInitialMessage(id, 'a.ts 文件', [], references)
    const restored = restoredInitialMessages(JSON.stringify(useInitialMessages.getState()))
    expect(restored[id]?.references).toEqual(references)
    useInitialMessages.setState(restored, true)
    const delivery = sendInitialMessage(id, rpc)
    reply(0, conversation)
    await settle()
    expect(sent[1]).toMatchObject({ params: { text: 'a.ts 文件', references } })
    reply(1, { ok: true })
    await delivery
  })

  it('shows the message while startup waits and sends its images only after readiness', async () => {
    const { rpc, sent, reply } = connection()
    keepInitialMessage(id, 'look at this', [image])
    const ref = useInitialMessages.getState()[id]?.ref
    const delivery = sendInitialMessage(id, rpc)
    expect(useInitialMessages.getState()[id]).toMatchObject({ text: 'look at this', images: [image], phase: 'starting' })
    expect(sent.map((frame) => frame.method)).toEqual(['conversations.continue'])
    expect(sendInitialMessage(id, rpc)).toBe(delivery)
    expect(sent).toHaveLength(1)
    reply(0, conversation)
    await settle()
    expect(sent[1]).toMatchObject({ method: 'conversations.send', params: { id, text: 'look at this', images: [image.id], ref } })
    expect(useInitialMessages.getState()[id]?.phase).toBe('sending')
    reply(1, { ok: true })
    await delivery
    expect(useInitialMessages.getState()[id]).toBeUndefined()
  })

  it('keeps the text and images when startup fails and reuses the ref on retry', async () => {
    const { rpc, sent, reply, fail } = connection()
    keepInitialMessage(id, '', [image])
    const ref = useInitialMessages.getState()[id]?.ref
    const first = sendInitialMessage(id, rpc)
    fail(0)
    await first
    expect(sent).toHaveLength(1)
    expect(useInitialMessages.getState()[id]).toMatchObject({ phase: 'failed', error: 'startup failed', text: '', images: [image], ref })
    const retry = sendInitialMessage(id, rpc)
    reply(1, conversation)
    await settle()
    expect(sent[2]).toMatchObject({ params: { text: '', images: [image.id], ref } })
    reply(2, { ok: true })
    await retry
    expect(useInitialMessages.getState()[id]).toBeUndefined()
  })

  it('retains a stable ref if the send reply is lost', async () => {
    const { rpc, sent, reply, fail } = connection()
    keepInitialMessage(id, 'once', [])
    const first = sendInitialMessage(id, rpc)
    reply(0, conversation)
    await settle()
    fail(1)
    await first
    const retry = sendInitialMessage(id, rpc)
    reply(2, conversation)
    await settle()
    expect(sent[3]?.params).toEqual(sent[1]?.params)
    reply(3, { ok: true })
    await retry
  })

  it('recognizes a delivered message even if its RPC reply is lost', async () => {
    const { rpc, reply, fail } = connection()
    keepInitialMessage(id, 'once', [])
    const message = useInitialMessages.getState()[id]
    if (!message) throw new Error('missing pending message')
    const first = sendInitialMessage(id, rpc)
    reply(0, conversation)
    await settle()
    acknowledgeInitialMessage(id, [{ kind: 'user', id: `u:${message.ref}`, stageId: 'stage', revision: 0, at: 0, text: 'once', images: [] }])
    fail(1)
    await first
    expect(useInitialMessages.getState()[id]).toBeUndefined()
  })

  it('restores interrupted delivery for manual retry, including images', () => {
    keepInitialMessage(id, 'still here', [image])
    const saved = useInitialMessages.getState()
    const restored = restoredInitialMessages(JSON.stringify(saved))
    expect(restored[id]).toMatchObject({ text: 'still here', images: [image], ref: saved[id]?.ref, phase: 'failed' })
    expect(restoredInitialMessages('{')).toEqual({})
    expect(restoredInitialMessages(JSON.stringify({ [id]: { text: 'incomplete' } }))).toEqual({})
  })
})

describe('durable initial message delivery', () => {
  const features = ['deferred-conversation-start', 'durable-initial-message', 'chat-references']
  const accepted = (phase: NonNullable<Conversation['initialMessage']>['phase'] = 'accepted'): Conversation => {
    const message = useInitialMessages.getState()[id]
    if (!message) throw new Error('missing local message')
    return { ...conversation, sessionId: null, initialMessage: { ...message, phase, error: null } }
  }

  it('submits the whole message once and keeps the server receipt after the local copy is gone', async () => {
    const { rpc, sent, reply } = connection(features)
    const references: ChatReference[] = [{ start: 0, end: 4, target: { kind: 'file', path: '/workspace/a.ts', relative: 'a.ts' } }]
    keepInitialMessage(id, 'a.ts', [image], references)
    const receipt = accepted()
    const delivery = sendInitialMessage(id, rpc)
    expect(sendInitialMessage(id, rpc)).toBe(delivery)
    expect(sent).toMatchObject([{ method: 'conversations.submit', params: { id, ref: receipt.initialMessage?.ref, text: 'a.ts', images: [image.id], references } }])
    reply(0, receipt)
    await delivery
    expect(useInitialMessages.getState()[id]).toBeUndefined()
    expect(useCore.getState().conversations[id]?.initialMessage).toEqual(receipt.initialMessage)
    await sendInitialMessage(id, rpc, true)
    expect(sent).toHaveLength(1)
  })

  it.each(['sending', 'sent', 'uncertain'] as const)('keeps a newer %s notification when the accepted reply arrives later', async (phase) => {
    const { rpc, reply, change } = connection(features)
    keepInitialMessage(id, 'once', [])
    const receipt = accepted()
    const newest = accepted(phase)
    const delivery = sendInitialMessage(id, rpc)
    change(newest)
    reply(0, receipt)
    await delivery
    expect(useCore.getState().conversations[id]?.initialMessage?.phase).toBe(phase)
    expect(useInitialMessages.getState()[id]).toBeUndefined()
  })

  it('does not treat an out-log user item as delivery, and retries a lost submit reply with the same ref', async () => {
    const { rpc, sent, reply } = connection(features)
    keepInitialMessage(id, 'once', [image])
    const receipt = accepted()
    const message = receipt.initialMessage!
    const first = sendInitialMessage(id, rpc)
    acknowledgeInitialMessage(id, [{ kind: 'user', id: `u:${message.ref}`, stageId: 'stage', revision: 0, at: 0, text: 'once', images: [image] }])
    expect(useInitialMessages.getState()[id]).toBeDefined()
    rpc.failAll(new Error('connection closed'))
    await first
    expect(useInitialMessages.getState()[id]).toMatchObject({ phase: 'failed', ref: message.ref })
    useInitialMessages.setState(restoredInitialMessages(JSON.stringify(useInitialMessages.getState())), true)
    await sendInitialMessage(id, rpc)
    expect(sent).toHaveLength(1)
    const retry = sendInitialMessage(id, rpc, true)
    expect(sent[1]).toMatchObject({ method: 'conversations.submit', params: { ref: message.ref, retry: true, text: 'once', images: [image.id] } })
    reply(1, receipt)
    await retry
  })

  it('retries a persisted failed receipt without local storage and never retries uncertain delivery', async () => {
    const { rpc, sent, reply, change } = connection(features)
    keepInitialMessage(id, 'once', [image])
    const failed = accepted('failed')
    const uncertain = accepted('uncertain')
    useInitialMessages.setState({}, true)
    change(failed)
    await sendInitialMessage(id, rpc)
    expect(sent).toHaveLength(0)
    const retry = sendInitialMessage(id, rpc, true)
    expect(sent[0]).toMatchObject({ method: 'conversations.submit', params: { ref: failed.initialMessage?.ref, retry: true } })
    reply(0, uncertain)
    await retry
    acknowledgeInitialMessage(id, [{ kind: 'user', id: `u:${failed.initialMessage?.ref}`, stageId: 'stage', revision: 0, at: 0, text: 'once', images: [image] }])
    expect(useCore.getState().conversations[id]?.initialMessage?.phase).toBe('uncertain')
    await sendInitialMessage(id, rpc, true)
    expect(sent).toHaveLength(1)
  })
})
