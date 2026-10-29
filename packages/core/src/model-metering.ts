import { z } from 'zod'
import type { ModelMetering, ModelTokens } from '@conclave/protocol'

const count = z.number().int().nonnegative()
const cost = z.number().nonnegative()
export const ClaudeTokenUsage = z.looseObject({
  input_tokens: count.optional(), output_tokens: count.optional(),
  cache_creation_input_tokens: count.optional(), cache_read_input_tokens: count.optional(),
  cache_creation: z.looseObject({ ephemeral_5m_input_tokens: count.optional(), ephemeral_1h_input_tokens: count.optional() }).optional()
})
const ClaudeModelUsage = z.looseObject({
  inputTokens: count, outputTokens: count, cacheReadInputTokens: count, cacheCreationInputTokens: count,
  costUSD: cost.optional()
})
const ClaudeResult = z.looseObject({
  result: z.string().optional(), is_error: z.boolean().optional(),
  usage: ClaudeTokenUsage.optional().catch(undefined), model: z.string().optional(),
  modelUsage: z.record(z.string(), ClaudeModelUsage).optional().catch(undefined),
  num_turns: count.optional(), total_cost_usd: cost.optional()
})

// A turn on a provider's plan: its tokens stand, what the agent priced them at does not.
export function withoutCost(metering: ModelMetering): ModelMetering {
  return { ...metering, reportedCostUsd: null, models: metering.models.map((model) => ({ ...model, costUsd: null })) }
}

export type QuickAnswer = { text: string; metering?: ModelMetering; failed?: boolean }

export function claudeTokens(model: string | null, usage: z.infer<typeof ClaudeTokenUsage>, requestInputs?: number[]): ModelTokens | null {
  if (usage.input_tokens === undefined || usage.output_tokens === undefined) return null
  const write = usage.cache_creation_input_tokens ?? null
  return {
    model, input: usage.input_tokens + (write ?? 0) + (usage.cache_read_input_tokens ?? 0), output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? null, cacheWrite: write,
    cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? (write === 0 ? 0 : null),
    costUsd: null, ...(requestInputs ? { requestInputs } : {})
  }
}

export function claudeMetering(frame: unknown, model: string | null, requests: readonly { model: string | null; input: number }[] = []): ModelMetering | undefined {
  const parsed = ClaudeResult.safeParse(frame)
  if (!parsed.success) return undefined
  const result = parsed.data
  const models = Object.entries(result.modelUsage ?? {}).map(([name, usage]): ModelTokens => ({
    model: name, input: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    output: usage.outputTokens, cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens,
    cacheWrite1h: usage.cacheCreationInputTokens === 0 ? 0 : null, costUsd: usage.costUSD ?? null,
    requestInputs: requests.filter((request) => request.model === name).map((request) => request.input)
  }))
  if (models.length === 0 && result.usage) {
    const names = new Set(requests.map((request) => request.model))
    const resolved = requests.length ? names.size === 1 ? requests[0]?.model ?? null : null : model
    const tokens = claudeTokens(result.model ?? resolved, result.usage, requests.map((request) => request.input))
    if (tokens) models.push(tokens)
  }
  // Cache-duration detail is turn-wide; it can be assigned only when exactly one model ran.
  const only = models.length === 1 ? models[0] : undefined
  if (only && result.usage?.cache_creation?.ephemeral_1h_input_tokens !== undefined) only.cacheWrite1h = result.usage.cache_creation.ephemeral_1h_input_tokens
  if (only && result.num_turns === 1 && only.requestInputs?.length === 0) only.requestInputs = [only.input]
  if (models.length === 0) return undefined
  return { models, calls: result.num_turns ?? null, callsEstimated: result.num_turns === undefined, reportedCostUsd: result.total_cost_usd ?? null }
}

function json(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

export function parseClaudeQuick(printed: string, model: string | null): QuickAnswer {
  const frame = json(printed)
  const parsed = ClaudeResult.safeParse(frame)
  if (!parsed.success) return { text: '' }
  return { text: parsed.data.result ?? '', metering: claudeMetering(frame, model), failed: parsed.data.is_error }
}

const CodexResult = z.looseObject({ type: z.enum(['turn.completed', 'turn.failed']), usage: z.looseObject({
  input_tokens: count, output_tokens: count, cached_input_tokens: count.optional(), cache_write_input_tokens: count.optional()
}) })

export function parseCodexQuick(printed: string, model: string | null): QuickAnswer {
  const frames = printed.split('\n').map(json)
  const failed = frames.some((frame) => z.object({ type: z.literal('turn.failed') }).safeParse(frame).success)
  const models = frames.flatMap((frame): ModelTokens[] => {
    const result = CodexResult.safeParse(frame)
    if (!result.success) return []
    const usage = result.data.usage
    return [{ model, input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cached_input_tokens ?? null,
      cacheWrite: usage.cache_write_input_tokens ?? 0, cacheWrite1h: 0, costUsd: null }]
  })
  return { text: '', failed, ...(models.length ? { metering: { models, calls: models.length, callsEstimated: true, reportedCostUsd: null } } : {}) }
}

const CursorResult = z.looseObject({ result: z.string(), is_error: z.boolean().optional(), model: z.string().optional(), usage: z.looseObject({
  inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count
}).optional().catch(undefined) })

export function parseCursorQuick(printed: string, model: string | null): QuickAnswer {
  const result = CursorResult.safeParse(json(printed))
  if (!result.success) return { text: '' }
  const usage = result.data.usage
  const input = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0
  return { text: result.data.result, failed: result.data.is_error, ...(usage ? { metering: {
    models: [{ model: result.data.model ?? model, input, output: usage.outputTokens, cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens, cacheWrite1h: usage.cacheWriteTokens === 0 ? 0 : null, costUsd: null }],
    calls: 1, callsEstimated: true, reportedCostUsd: null
  } } : {}) }
}
