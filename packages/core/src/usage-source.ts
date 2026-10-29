import type { ResetCreditOutcome, ResetCredits, UsageWindow } from '@conclave/protocol'
import { ProxyAgent } from 'undici'

export function getProxyDispatcher(): ProxyAgent | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || 'http://127.0.0.1:7897'
  try {
    return new ProxyAgent(proxy)
  } catch {
    return undefined
  }
}

export type UsageReading =
  | { signedIn: false }
  | { signedIn: true; windows: UsageWindow[]; plan: string | null; resetCredits?: ResetCredits | null }

// home: an account's own folder (AccountSupport); without one, the user's.
export type UsageSource = (home?: string) => Promise<UsageReading>

// Spends one usage reset, the one `creditId` names if given, under an id the service uses to spend
// it at most once.
export type ResetCreditUse = (requestId: string, creditId?: string, home?: string) => Promise<ResetCreditOutcome>

// What a running agent said about its limits, and when: the frame's time as it came in, which a
// stage replayed from its log keeps. The windows it named (the rest unchanged), and whether the full
// reading is worth fetching again now.
export type UsageReport = { at: number; windows: UsageWindow[]; plan?: string | null; refresh?: boolean }

// Two reports a driver saw before the host took them, the later winning window by window.
export function mergeUsageReports(earlier: UsageReport | null, later: UsageReport): UsageReport {
  const kept = (earlier?.windows ?? []).filter((old) => !later.windows.some((window) => window.kind === old.kind && window.model === old.model))
  return {
    at: Math.max(earlier?.at ?? later.at, later.at),
    windows: [...kept, ...later.windows],
    plan: later.plan ?? earlier?.plan,
    refresh: Boolean(earlier?.refresh || later.refresh)
  }
}

export type UsageFailure = 'auth-expired' | 'request-failed'

export class UsageFetchError extends Error {
  constructor(
    readonly code: UsageFailure,
    message: string
  ) {
    super(message)
  }
}

const TIMEOUT_MS = 10_000

// A body makes it a POST, as an RPC-style endpoint wants.
export async function fetchUsageJson(url: string, headers: Record<string, string>, body?: string, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  let response: Response
  const dispatcher = getProxyDispatcher()
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher: dispatcher as any } : {}),
      ...(body === undefined ? {} : { method: 'POST', body })
    })
  } catch (error) {
    throw new UsageFetchError('request-failed', error instanceof Error ? error.message : String(error))
  }
  // Access tokens expire between agent runs; the agent's own CLI refreshes them, Conclave never writes credentials.
  if (response.status === 401 || response.status === 403) {
    throw new UsageFetchError('auth-expired', `${url} answered ${response.status}`)
  }
  if (!response.ok) {
    throw new UsageFetchError('request-failed', `${url} answered ${response.status}`)
  }
  return response.json()
}

export function parseJson(raw: string | null): unknown {
  if (raw === null) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
