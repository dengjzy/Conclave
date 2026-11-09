import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { UsageWindow } from '@conclave/protocol'
import { UsageFetchError, type UsageReading } from '../../usage-source'
import { grokHome } from './grok-cli'

const BILLING = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token'
const ISSUER = 'https://auth.x.ai'
// The subscription proxy answers only when the request names a Grok CLI.
const CLIENT_VERSION = '1.0.77'
const WEEK_MINUTES = 7 * 24 * 60

const Auth = z.object({
  key: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_at: z.string().optional(),
  oidc_issuer: z.string().optional(),
  oidc_client_id: z.string().optional()
})
type Auth = z.infer<typeof Auth>

const Billing = z.looseObject({
  config: z.looseObject({
    currentPeriod: z.looseObject({ end: z.string().optional() }).optional(),
    creditUsagePercent: z.number().optional(),
    productUsage: z.array(z.looseObject({ product: z.string().optional(), usagePercent: z.number().optional() })).optional()
  }).optional()
})

const refreshed = new Map<string, { token: string; until: number }>()

function entries(value: unknown): Auth[] {
  const one = Auth.safeParse(value)
  if (one.success && (one.data.key || one.data.access_token || one.data.refresh_token)) return [one.data]
  const record = z.record(z.string(), z.unknown()).safeParse(value)
  if (!record.success) return []
  return Object.values(record.data).flatMap((item) => {
    const parsed = Auth.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

function percent(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

export function parseGrokBilling(body: unknown): UsageWindow[] {
  const parsed = Billing.safeParse(body)
  if (!parsed.success || !parsed.data.config) throw new UsageFetchError('request-failed', 'Grok 的额度响应无法识别')
  const config = parsed.data.config
  const reset = Date.parse(config.currentPeriod?.end ?? '')
  const resetsAt = Number.isFinite(reset) ? reset : null
  const window = (used: number, model: string | null): UsageWindow => ({ kind: 'weekly', model, usedPercent: used, windowMinutes: WEEK_MINUTES, resetsAt })
  const overall = percent(config.creditUsagePercent)
  const products = (config.productUsage ?? []).flatMap((item) => {
    const used = percent(item.usagePercent)
    const name = item.product?.trim()
    return used === null || !name ? [] : [window(used, name)]
  })
  return [...(overall === null ? [] : [window(overall, null)]), ...products]
}

async function refreshAccess(entry: Auth): Promise<string> {
  const refresh = entry.refresh_token?.trim()
  const clientId = entry.oidc_client_id?.trim()
  // A file can name any issuer. The refresh token goes only to xAI's own endpoint.
  if (!refresh || !clientId || entry.oidc_issuer !== ISSUER) throw new UsageFetchError('auth-expired', 'Grok 登录已过期，请在终端重新登录')
  const cached = refreshed.get(refresh)
  if (cached && cached.until > Date.now()) return cached.token
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error'
    })
  } catch { throw new UsageFetchError('request-failed', 'Grok 登录刷新失败') }
  if (response.status === 400 || response.status === 401 || response.status === 403) throw new UsageFetchError('auth-expired', 'Grok 登录已过期，请在终端重新登录')
  if (!response.ok) throw new UsageFetchError('request-failed', `Grok 登录刷新失败（${response.status}）`)
  let body: unknown
  try { body = await response.json() } catch { throw new UsageFetchError('request-failed', 'Grok 登录刷新失败') }
  const parsed = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().default(3600) }).safeParse(body)
  if (!parsed.success) throw new UsageFetchError('request-failed', 'Grok 登录刷新失败')
  refreshed.set(refresh, { token: parsed.data.access_token, until: Date.now() + parsed.data.expires_in * 1000 - 60_000 })
  return parsed.data.access_token
}

async function bearer(entry: Auth): Promise<string | null> {
  const current = (entry.key ?? entry.access_token)?.trim()
  const expiry = Date.parse(entry.expires_at ?? '')
  if (current && (!Number.isFinite(expiry) || expiry > Date.now() + 60_000)) return current
  if (entry.refresh_token?.trim() && entry.oidc_client_id?.trim() && entry.oidc_issuer === ISSUER) return refreshAccess(entry)
  return current || null
}

async function readAuth(file: string): Promise<Auth | null> {
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw new UsageFetchError('request-failed', '无法读取 Grok 登录')
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new UsageFetchError('request-failed', 'Grok 登录文件无法识别') }
  return entries(value).find((entry) => (entry.key ?? entry.access_token)?.trim() || entry.refresh_token?.trim()) ?? null
}

export async function readGrokUsage(): Promise<UsageReading> {
  const entry = await readAuth(path.join(grokHome(), 'auth.json'))
  if (!entry) return { signedIn: false }
  const token = await bearer(entry)
  if (!token) return { signedIn: false }
  let response: Response
  try {
    response = await fetch(BILLING, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'x-xai-token-auth': 'xai-grok-cli',
        'x-grok-client-version': CLIENT_VERSION
      },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error'
    })
  } catch { throw new UsageFetchError('request-failed', 'Grok 额度请求失败') }
  if (response.status === 401 || response.status === 403) throw new UsageFetchError('auth-expired', 'Grok 登录已过期，请在终端重新登录')
  if (!response.ok) throw new UsageFetchError('request-failed', `Grok 额度接口返回 ${response.status}`)
  let body: unknown
  try { body = await response.json() } catch { throw new UsageFetchError('request-failed', 'Grok 的额度响应无法识别') }
  return { signedIn: true, windows: parseGrokBilling(body), plan: null }
}
