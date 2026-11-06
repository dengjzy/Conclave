import { nodeStorage } from './remote/node-storage'
import { t } from './i18n'
import { create } from 'zustand'
import { z } from 'zod'
import { ConversationInitialMessage, RpcError, type ChatImage, type ChatReference, type ChatItem, type Conversation, type RpcConnection } from '@conclave/protocol'
import { reasonText } from './labels'
import { useCore } from './core-store'

const InitialMessage = ConversationInitialMessage.extend({ durable: z.boolean().optional() })
export type InitialMessage = z.infer<typeof InitialMessage>
const Messages = z.record(z.string(), InitialMessage)
const STORAGE_KEY = 'conclave.initial-messages'

// Submit is idempotent by ref, including when its reply was lost.
export function restoredInitialMessages(raw: string | null): Record<string, InitialMessage> {
  try {
    const parsed = Messages.safeParse(JSON.parse(raw ?? '{}'))
    if (!parsed.success) return {}
    return Object.fromEntries(Object.entries(parsed.data).map(([id, message]) => [id, {
      ...message, phase: 'failed' as const, error: message.error ?? t('initialMessages.sendIsUnfinishedTryAgain')
    }]))
  } catch { return {} }
}

function load(): Record<string, InitialMessage> {
  try { return restoredInitialMessages(nodeStorage.getItem(STORAGE_KEY)) } catch { return {} }
}

export const useInitialMessages = create<Record<string, InitialMessage>>()(load)
useInitialMessages.subscribe((messages) => {
  try { nodeStorage.setItem(STORAGE_KEY, JSON.stringify(messages)) } catch { /* Keep the in-memory copy. */ }
})

export function keepInitialMessage(id: string, text: string, images: readonly ChatImage[], references?: ChatReference[]): void {
  useInitialMessages.setState({ [id]: { ref: crypto.randomUUID(), text, images: [...images], at: Date.now(), ...(references?.length ? { references } : {}), phase: 'starting', error: null } })
}

export function useInitialMessage(conversation: Conversation): InitialMessage | undefined {
  const local = useInitialMessages((messages) => messages[conversation.id])
  const message = conversation.initialMessage ?? local
  return message?.phase === 'sent' ? undefined : message
}

function discard(id: string): void {
  useInitialMessages.setState((messages) => {
    const { [id]: _removed, ...rest } = messages
    return rest
  }, true)
}

export function acknowledgeInitialMessage(id: string, items: readonly ChatItem[]): void {
  const message = useInitialMessages.getState()[id]
  // An out log precedes delivery; only core can acknowledge a durable message.
  if (useCore.getState().conversations[id]?.initialMessage) { if (message) discard(id); return }
  if (message?.durable) return
  if (message && items.some((item) => item.kind === 'user' && item.id === `u:${message.ref}`)) discard(id)
}

async function submitInitialMessage(id: string, rpc: RpcConnection, message: InitialMessage, retry: boolean): Promise<void> {
  const original = useCore.getState().conversations[id]
  let changed: Conversation | undefined
  const unlisten = rpc.on('conversations.changed', ({ conversation }) => {
    if (conversation.id === id && conversation.initialMessage) changed = conversation
  })
  try {
    const result = await rpc.call('conversations.submit', {
      id, ref: message.ref, text: message.text, images: message.images.map((image) => image.id),
      ...(rpc.features.includes('chat-references') ? { references: message.references } : {}),
      ...(retry ? { retry: true } : {})
    })
    if (useCore.getState().rpc !== rpc) return
    // Notifications can advance delivery before the submit reply reaches us.
    const receipt = changed?.initialMessage ?? result.initialMessage
    useCore.setState((state) => {
      const current = state.conversations[id]
      return { conversations: { ...state.conversations, [id]: current && current !== original ? { ...current, initialMessage: receipt } : changed ?? result } }
    })
    discard(id)
  } catch (error) {
    if (useCore.getState().conversations[id]?.initialMessage) { discard(id); return }
    const detail = error instanceof RpcError && error.reason ? reasonText(error.reason, error.message) : error instanceof Error ? error.message : String(error)
    useInitialMessages.setState({ [id]: { ...message, durable: true, phase: 'failed', error: detail } })
  } finally { unlisten() }
}

// Delivery belongs to the message, so leaving its page cannot start it again.
const deliveries = new Map<string, Promise<void>>()
export function sendInitialMessage(id: string, rpc: RpcConnection, retry = false): Promise<void> {
  const pending = deliveries.get(id)
  if (pending) return pending
  const durable = rpc.features.includes('durable-initial-message')
  const receipt = useCore.getState().conversations[id]?.initialMessage
  const message = durable ? receipt ?? useInitialMessages.getState()[id] : useInitialMessages.getState()[id]
  if (!message) return Promise.resolve()
  if (durable && receipt && (receipt.phase !== 'failed' || !retry)) return Promise.resolve()
  if (durable && message.phase === 'failed' && !retry) return Promise.resolve()
  useInitialMessages.setState({ [id]: { ...message, ...(durable ? { durable: true } : {}), phase: 'starting', error: null } })
  const delivery = (durable ? submitInitialMessage(id, rpc, message, retry) : (async () => {
    try {
      await rpc.call('conversations.continue', { id })
      if (!useInitialMessages.getState()[id]) return
      useInitialMessages.setState({ [id]: { ...message, phase: 'sending', error: null } })
      await rpc.call('conversations.send', { id, text: message.text, images: message.images.map((image) => image.id), ref: message.ref, ...(rpc.features.includes('chat-references') ? { references: message.references } : {}) })
      discard(id)
    } catch (error) {
      if (!useInitialMessages.getState()[id]) return
      const detail = error instanceof RpcError && error.reason ? reasonText(error.reason, error.message) : error instanceof Error ? error.message : String(error)
      useInitialMessages.setState({ [id]: { ...message, phase: 'failed', error: detail } })
    }
  })()).finally(() => deliveries.delete(id))
  deliveries.set(id, delivery)
  return delivery
}
