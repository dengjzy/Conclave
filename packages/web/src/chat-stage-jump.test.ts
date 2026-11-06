import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '@conclave/protocol'
import type { ChatPage } from './chat-state'
import { finishStageJump, loadStageHistory, requestStageJump, useStageJump } from './chat-stage-jump'

const item = (stageId: string): ChatItem => ({ kind: 'assistant', revision: 0, id: stageId, stageId, text: 'record', streaming: false, at: 1 })
beforeEach(() => useStageJump.setState({ request: null }))

describe('stage record navigation', () => {
  it('loads earlier pages until the requested stage has messages, not just a synthetic divider', async () => {
    let page: ChatPage = { items: [item('latest')], before: 'cursor-1' }
    let calls = 0
    expect(await loadStageHistory('old', () => page, async () => {
      calls++
      page = calls === 1 ? { items: [item('middle')], before: 'cursor-2' } : { items: [item('old')], before: null }
      return 'loaded'
    }, () => false)).toBe('ready')
    expect(calls).toBe(2)
  })
  it('stops after cancellation without loading another page', async () => {
    let cancelled = false
    let calls = 0
    expect(await loadStageHistory('old', () => ({ items: [], before: 'cursor' }), async () => { calls++; cancelled = true; return 'loaded' }, () => cancelled)).toBe('cancelled')
    expect(calls).toBe(1)
  })
  it('bounds automatic pagination and detects a stalled cursor', async () => {
    let cursor = 0
    const page = () => ({ items: [], before: String(cursor) })
    expect(await loadStageHistory('old', page, async () => { cursor++; return 'loaded' }, () => false, 2)).toBe('limited')
    expect(cursor).toBe(2)
    expect(await loadStageHistory('old', page, async () => 'loaded', () => false)).toBe('failed')
    expect(await loadStageHistory('old', () => ({ items: [], before: null }), async () => 'done', () => false)).toBe('missing')
  })
  it('keeps a newer navigation request when an older lookup finishes', () => {
    requestStageJump('a', 'stage-1')
    const first = useStageJump.getState().request
    requestStageJump('b', 'stage-2')
    if (!first) throw new Error('missing request')
    finishStageJump(first.seq)
    expect(useStageJump.getState().request).toMatchObject({ conversationId: 'b', stageId: 'stage-2' })
    finishStageJump(useStageJump.getState().request?.seq ?? 0)
    expect(useStageJump.getState().request).toBeNull()
  })
})
