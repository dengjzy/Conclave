import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentDescriptor, modelPrice, tokenCost, type AgentKind, type ModelMetering, type ModelTokens, type UsageEvent } from '@conclave/protocol'

export const Counts = z.looseObject({ input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional(),
  cached_input_tokens: z.number().int().nonnegative().optional(), cache_write_input_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(), reasoning_output_tokens: z.number().int().nonnegative().optional() })
export type Counts = z.infer<typeof Counts>
export const ParserState = z.object({
  session: z.string().nullable(), model: z.string().nullable(), cwd: z.string().nullable(), turn: z.string().nullable(),
  total: Counts.nullable(), last: z.string().nullable()
})
export type ParserState = z.infer<typeof ParserState>
export const emptyParser = (): ParserState => ({ session: null, model: null, cwd: null, turn: null, total: null, last: null })
export const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')

export function meteredModels(metering: ModelMetering): ModelTokens[] {
  const only = metering.models.length === 1 ? metering.models[0] : undefined
  return only && only.costUsd === null && metering.reportedCostUsd !== null
    ? [{ ...only, costUsd: metering.reportedCostUsd }] : metering.models
}

export function usageEvent(agent: AgentKind, id: string, at: number, state: Pick<ParserState, 'session' | 'model' | 'cwd' | 'turn'>, tokens: Partial<ModelTokens>, fields: Partial<UsageEvent> = {}): UsageEvent {
  const event: UsageEvent = {
    id, agent, at, account: null, identity: null, session: state.session, turn: state.turn, cwd: state.cwd,
    source: 'external', origin: 'transcript', precision: 'request', model: state.model,
    input: 0, output: 0, cacheRead: null, cacheWrite: null, cacheWrite1h: null, costUsd: null, costKind: null,
    ...tokens, ...fields
  }
  if (event.costUsd !== null) event.costKind ??= 'reported'
  else {
    const price = modelPrice(agentDescriptor(agent).prices, event.model, event.at)
    event.costUsd = price ? tokenCost(event, price) : null
    if (event.costUsd !== null) event.costKind = 'estimated'
  }
  return event
}

const Claude = z.looseObject({ type: z.string(), timestamp: z.string().optional(), sessionId: z.string().optional(),
  requestId: z.string().optional(), uuid: z.string().optional(), cwd: z.string().optional(),
  message: z.looseObject({ id: z.string().optional(), model: z.string().optional(), usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(), cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation: z.object({ ephemeral_1h_input_tokens: z.number().int().nonnegative().optional() }).optional()
  }).optional() }).optional()
})
const Codex = z.looseObject({ type: z.string(), timestamp: z.string().optional(), payload: z.looseObject({
  id: z.string().optional(), model: z.string().optional(), cwd: z.string().optional(), type: z.string().optional(),
  turn_id: z.string().optional(), info: z.looseObject({ total_token_usage: Counts.nullish(), last_token_usage: Counts.nullish() }).nullish()
}) })

export function parseUsageLine(agent: 'claude' | 'codex', raw: string, state: ParserState): UsageEvent | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (agent === 'claude') {
    const parsed = Claude.safeParse(value)
    if (!parsed.success) return null
    const line = parsed.data
    state.session = line.sessionId ?? state.session
    state.cwd = line.cwd ?? state.cwd
    if (line.type === 'user') state.turn = line.uuid ?? null
    const usage = line.message?.usage, at = Date.parse(line.timestamp ?? '')
    if (line.type !== 'assistant' || !usage || !Number.isFinite(at) || line.message?.model === '<synthetic>') return null
    state.model = line.message?.model ?? null
    const id = line.message?.id ? `${line.message.id}/${line.requestId ?? ''}` : fingerprint(raw)
    const write = usage.cache_creation_input_tokens ?? null
    return usageEvent(agent, id, at, state, {
      input: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (write ?? 0), output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? null, cacheWrite: write,
      cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? (write === 0 ? 0 : null),
      requestInputs: [usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (write ?? 0)]
    })
  }
  const parsed = Codex.safeParse(value)
  if (!parsed.success) return null
  const { type, payload, timestamp } = parsed.data
  if (type === 'session_meta') state.session = payload.id ?? state.session
  state.cwd = payload.cwd ?? state.cwd
  state.model = payload.model ?? state.model
  if (payload.type === 'task_started' || type === 'turn_context') state.turn = payload.turn_id ?? state.turn
  if (payload.type !== 'token_count' || !payload.info) return null
  const total = payload.info.total_token_usage ?? null, last = payload.info.last_token_usage ?? null
  const at = Date.parse(timestamp ?? '')
  if (!Number.isFinite(at) || (!total && !last)) return null
  const signature = JSON.stringify(total ?? last)
  if (state.last === signature) return null
  state.last = signature
  const before = state.total
  state.total = total
  if (total && before && (total.input_tokens ?? 0) < (before.input_tokens ?? 0) && !last) return null
  // A copied initial cumulative snapshot is a baseline when the call's own delta exists.
  const delta = last ?? (total ? {
    input_tokens: Math.max(0, (total.input_tokens ?? 0) - (before?.input_tokens ?? 0)),
    output_tokens: Math.max(0, (total.output_tokens ?? 0) - (before?.output_tokens ?? 0)),
    cached_input_tokens: Math.max(0, (total.cached_input_tokens ?? 0) - (before?.cached_input_tokens ?? 0)),
    cache_write_input_tokens: Math.max(0, (total.cache_write_input_tokens ?? 0) - (before?.cache_write_input_tokens ?? 0))
  } : null)
  if (!delta) return null
  return usageEvent(agent, fingerprint(`${timestamp}/${JSON.stringify(total)}/${JSON.stringify(last)}`), at, state, {
    input: delta.input_tokens ?? 0, output: delta.output_tokens ?? 0, cacheRead: delta.cached_input_tokens ?? null,
    cacheWrite: delta.cache_write_input_tokens ?? 0, cacheWrite1h: 0, requestInputs: [delta.input_tokens ?? 0]
  })
}
