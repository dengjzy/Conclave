import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ResetCreditOutcome, ResetCredits, UsageWindow } from '@conclave/protocol'
import { fetchUsageJson, parseJson, type UsageReading } from '../../usage-source'
import { codexDefaultHome } from './codex-account'

// The endpoint behind Codex's /status; only ChatGPT sign-ins have plan limits.
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
// Asked only when the usage reply leaves the reset credits out or incomplete.
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
// Spends one, as the Codex CLI does: the credit named by id, of the one type it sends. The service
// may take longer over it than over a reading.
const CONSUME_URL = `${RESET_CREDITS_URL}/consume`
const CONSUME_TIMEOUT_MS = 30_000
const CONSUME_CREDIT_TYPE = 'usage_limit'
const CONSUME_OUTCOMES: Record<string, ResetCreditOutcome> = {
  reset: 'reset',
  nothing_to_reset: 'nothing-to-reset',
  no_credit: 'no-credit',
  already_redeemed: 'already-used'
}
const SESSION_MINUTES = 300
const WEEK_MINUTES = 10_080
// Older Codex builds report window lengths a minute off.
const WINDOW_TOLERANCE_MINUTES = 1

// An API-key sign-in has `tokens: null`: it is billed per token and has no windows to show.
const Auth = z.object({
  tokens: z.object({ access_token: z.string().min(1), account_id: z.string().nullish() }).nullish()
})

const Window = z.object({
  used_percent: z.number(),
  limit_window_seconds: z.number().nullish(),
  reset_at: z.number().nullish()
})

// Field names as the credits endpoint answers; every part is optional, since the service does not document it.
const Credits = z.object({
  available_count: z.number().nullish().catch(null),
  credits: z
    .array(
      z.object({
        id: z.string().nullish().catch(null),
        status: z.string().nullish(),
        expires_at: z.union([z.string(), z.number()]).nullish(),
        // Such as "Full reset (Weekly + 5 hr)".
        title: z.string().nullish().catch(null)
      })
    )
    .nullish()
    .catch(null)
})

const UsageResponse = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z
    .object({ primary_window: Window.nullish().catch(null), secondary_window: Window.nullish().catch(null) })
    .nullish(),
  rate_limit_reset_credits: Credits.nullish().catch(null)
})

// Seconds or milliseconds, as a number or a string, or an ISO date.
function timestamp(value: string | number | null | undefined): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function parseResetCredits(body: unknown): ResetCredits | null {
  const parsed = Credits.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const { available_count, credits } = parsed.data
  const available = (credits ?? []).filter((credit) => credit.status?.toLowerCase() === 'available')
  const count = typeof available_count === 'number' && Number.isFinite(available_count) ? available_count : credits ? available.length : null
  if (count === null) {
    return null
  }
  // Soonest first, credits without an expiry last. Codex's resets are full ones (weekly + 5 hr).
  const listed = available
    .map((credit) => ({
      ...(credit.id ? { id: credit.id } : {}),
      expiresAt: timestamp(credit.expires_at),
      label: credit.title?.trim() || null,
      clears: ['session' as const, 'weekly' as const]
    }))
    .sort((a, b) => (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY))
  return { available: Math.max(0, Math.floor(count)), credits: listed, blockedBy: null }
}

export function classify(minutes: number | null): UsageWindow['kind'] | null {
  if (minutes === null) {
    return null
  }
  if (Math.abs(minutes - SESSION_MINUTES) <= WINDOW_TOLERANCE_MINUTES) {
    return 'session'
  }
  return Math.abs(minutes - WEEK_MINUTES) <= WINDOW_TOLERANCE_MINUTES ? 'weekly' : null
}

// One Codex window, as the usage endpoint and the app-server's rate-limit updates both describe it.
export function windowOf(
  usedPercent: number,
  minutes: number | null,
  resetsAtSeconds: number | null | undefined,
  fallback: UsageWindow['kind']
): UsageWindow | null {
  if (!Number.isFinite(usedPercent)) {
    return null
  }
  const kind = classify(minutes) ?? fallback
  return {
    kind,
    model: null,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes: kind === 'session' ? SESSION_MINUTES : WEEK_MINUTES,
    // Codex reports Unix seconds.
    resetsAt: resetsAtSeconds ? resetsAtSeconds * 1000 : null
  }
}

function toWindow(raw: z.infer<typeof Window> | null | undefined, fallback: UsageWindow['kind']): UsageWindow | null {
  if (!raw) {
    return null
  }
  const minutes = raw.limit_window_seconds ? Math.ceil(raw.limit_window_seconds / 60) : null
  return windowOf(raw.used_percent, minutes, raw.reset_at, fallback)
}

// `resetCredits` is undefined when the reply said nothing about them, null when it said something unreadable.
export function parseCodexUsage(body: unknown): {
  windows: UsageWindow[]
  plan: string | null
  resetCredits: ResetCredits | null | undefined
} {
  const parsed = UsageResponse.safeParse(body)
  if (!parsed.success) {
    return { windows: [], plan: null, resetCredits: undefined }
  }
  const { plan_type, rate_limit, rate_limit_reset_credits } = parsed.data
  // Primary is normally the 5-hour window and secondary the weekly one; durations win when present.
  const windows = [toWindow(rate_limit?.primary_window, 'session'), toWindow(rate_limit?.secondary_window, 'weekly')]
  return {
    windows: windows.filter((window) => window !== null),
    plan: plan_type ?? null,
    resetCredits: rate_limit_reset_credits === undefined ? undefined : parseResetCredits(rate_limit_reset_credits)
  }
}

// Credits are a nice-to-have: failing to read them never fails the usage reading itself.
async function supplementResetCredits(
  known: ResetCredits | null | undefined,
  headers: Record<string, string>
): Promise<ResetCredits | null> {
  // A count with nothing about when they expire is incomplete too; the credits endpoint lists them.
  if (known && (known.available === 0 || known.credits.length > 0)) {
    return known
  }
  try {
    return parseResetCredits(await fetchUsageJson(RESET_CREDITS_URL, headers)) ?? known ?? null
  } catch {
    return known ?? null
  }
}

// home: an account's own folder; without one, the user's.
async function readTokens(home?: string) {
  const raw = await readFile(path.join(home ?? codexDefaultHome(), 'auth.json'), 'utf8').catch(() => null)
  const auth = Auth.safeParse(parseJson(raw))
  return auth.success ? auth.data.tokens : null
}

// Whether Codex has an account here, without asking the service anything.
export async function hasCodexCredentials(home?: string): Promise<boolean> {
  return (await readTokens(home)) !== null
}

// Sent as the Codex client, the one these endpoints serve; same headers as Orca.
function codexHeaders(tokens: NonNullable<z.infer<typeof Auth>['tokens']>): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.access_token}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
    ...(tokens.account_id ? { 'ChatGPT-Account-Id': tokens.account_id } : {})
  }
}

export async function readCodexUsage(home?: string): Promise<UsageReading> {
  const tokens = await readTokens(home)
  if (!tokens) {
    return { signedIn: false }
  }
  const headers = codexHeaders(tokens)
  const usage = parseCodexUsage(await fetchUsageJson(USAGE_URL, headers))
  return { signedIn: true, ...usage, resetCredits: await supplementResetCredits(usage.resetCredits, headers) }
}

export function parseConsumeOutcome(body: unknown): ResetCreditOutcome {
  const code = z.object({ code: z.string() }).safeParse(body)
  const outcome = code.success ? CONSUME_OUTCOMES[code.data.code] : undefined
  if (!outcome) {
    throw new Error(`Codex 返回了无法识别的结果：${JSON.stringify(body)}`)
  }
  return outcome
}

export function consumeRequest(requestId: string, creditId?: string): Record<string, string> {
  return { redeem_request_id: requestId, ...(creditId ? { credit_id: creditId } : {}), credit_type: CONSUME_CREDIT_TYPE }
}

export async function useCodexResetCredit(requestId: string, creditId?: string, home?: string): Promise<ResetCreditOutcome> {
  const tokens = await readTokens(home)
  if (!tokens) {
    throw new Error('Codex 没有登录')
  }
  const headers = { ...codexHeaders(tokens), 'Content-Type': 'application/json' }
  return parseConsumeOutcome(await fetchUsageJson(CONSUME_URL, headers, JSON.stringify(consumeRequest(requestId, creditId)), CONSUME_TIMEOUT_MS))
}
