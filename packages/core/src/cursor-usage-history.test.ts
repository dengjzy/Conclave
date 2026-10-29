import { expect, it } from 'vitest'
import { cursorUsageEvent } from './cursor-usage-history'

it('normalizes Cursor cache buckets without double counting and retains a reported zero cost', () => {
  const event = cursorUsageEvent({ timestamp: '1792656000000', conversationId: 'chat', model: 'auto',
    tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalCents: 0 } })
  expect(event).toMatchObject({ input: 15, output: 5, cacheRead: 3, cacheWrite: 2, costUsd: 0, costKind: 'reported' })
  expect(cursorUsageEvent({ timestamp: 'not-a-date', tokenUsage: {} })).toBeNull()
})
