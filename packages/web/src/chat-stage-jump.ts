import { create } from 'zustand'
import type { ChatPage } from './chat-state'

export type StageJump = { conversationId: string; stageId: string; seq: number }
export const useStageJump = create<{ request: StageJump | null }>(() => ({ request: null }))
let sequence = 0
export function requestStageJump(conversationId: string, stageId: string): void {
  useStageJump.setState({ request: { conversationId, stageId, seq: ++sequence } })
}
export function finishStageJump(seq: number): void {
  useStageJump.setState((state) => state.request?.seq === seq ? { request: null } : {})
}

export type StageHistoryResult = 'ready' | 'missing' | 'failed' | 'limited' | 'cancelled'
export async function loadStageHistory(stageId: string, page: () => ChatPage | undefined, older: () => Promise<'loaded' | 'done' | 'failed'>, cancelled: () => boolean, limit = 20): Promise<StageHistoryResult> {
  for (let count = 0; ; count++) {
    if (cancelled()) return 'cancelled'
    const current = page()
    if (!current) return 'failed'
    if (current.items.some((item) => item.stageId === stageId && item.kind !== 'state')) return 'ready'
    if (!current.before) return 'missing'
    if (count >= limit) return 'limited'
    const before = current.before
    const result = await older()
    if (cancelled()) return 'cancelled'
    if (result === 'failed' || page()?.before === before) return 'failed'
  }
}
