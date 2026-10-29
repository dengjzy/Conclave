import { z } from 'zod'
import type { UsageEvent } from '@conclave/protocol'
import { readCursorAccessToken } from './agents/cursor/cursor-usage'
import { fetchUsageJson } from './usage-source'
import { fingerprint, usageEvent } from './usage-events'

const Event = z.looseObject({ timestamp: z.union([z.string(), z.number()]), model: z.string().optional(), conversationId: z.string().optional(),
  id: z.string().optional(), requestId: z.string().optional(),
  tokenUsage: z.object({ inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(), cacheWriteTokens: z.number().nonnegative().optional(), totalCents: z.number().nonnegative().optional() }).optional(),
  chargedCents: z.number().nonnegative().optional()
})
const Page = z.object({ usageEventsDisplay: z.array(Event), totalUsageEventsCount: z.number().optional() })

export function cursorUsageEvent(raw: z.infer<typeof Event>, duplicate = 0): UsageEvent | null {
  const at = Number(raw.timestamp), tokens = raw.tokenUsage
  if (!Number.isFinite(at) || !tokens) return null
  const cents = tokens.totalCents ?? raw.chargedCents
  return usageEvent('cursor', raw.id ?? raw.requestId ?? fingerprint(`${JSON.stringify([raw.timestamp, raw.conversationId, raw.model, raw.tokenUsage])}/${duplicate}`), at, {
    session: raw.conversationId ?? null, turn: null, model: raw.model ?? null, cwd: null
  }, { input: (tokens.inputTokens ?? 0) + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0), output: tokens.outputTokens ?? 0,
    cacheRead: tokens.cacheReadTokens ?? null, cacheWrite: tokens.cacheWriteTokens ?? null, cacheWrite1h: 0,
    costUsd: cents === undefined ? null : cents / 100 }, { origin: 'cursor', account: 'default' })
}

export function cursorHistoryReader(now: () => number = Date.now) {
  let last = -Infinity
  let cached: UsageEvent[] = []
  return async (): Promise<UsageEvent[]> => {
    if (now() - last < 5 * 60_000) return cached
    const token = await readCursorAccessToken()
    if (!token) return []
    let identity: string | null = null
    try {
      const claims = z.object({ sub: z.string().optional(), email: z.string().optional() }).parse(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')))
      identity = claims.email ?? (claims.sub ? `cursor:${fingerprint(claims.sub).slice(0, 12)}` : null)
    } catch { /* An opaque token carries no historical account identity. */ }
    const events: UsageEvent[] = [], seen = new Map<string, number>()
    const end = now(), start = end - 92 * 86400_000
    for (let page = 1; page <= 40; page++) {
      const result = Page.parse(await fetchUsageJson('https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents',
        { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        JSON.stringify({ teamId: 0, startDate: String(start), endDate: String(end), page, pageSize: 300 })))
      for (const row of result.usageEventsDisplay) {
        const key = JSON.stringify(row), count = seen.get(key) ?? 0
        seen.set(key, count + 1)
        const event = cursorUsageEvent(row, count)
        if (event) events.push({ ...event, id: `${identity ?? 'unknown'}/${event.id}`, identity })
      }
      if (result.usageEventsDisplay.length < 300 || (result.totalUsageEventsCount !== undefined && events.length >= result.totalUsageEventsCount)) {
        cached = events; last = end; return cached
      }
    }
    throw new Error('Cursor history exceeds pagination limit')
  }
}
