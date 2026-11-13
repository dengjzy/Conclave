import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { UsageWindow } from '@conclave/protocol'
import { fetchUsageJson, getProxyDispatcher, parseJson, UsageFetchError, type UsageReading } from '../../usage-source'
import * as runtime from './antigravity-runtime'
import { antigravityCliTokenFile, isSystemDefaultGeminiHome, type AntigravityOAuthClient } from './antigravity-runtime'

// What the server's own /usage asks (ccpa_client.retrieve_user_quota_summary): CCPA's quota summary
// for the project its sign-in resolved. Free and Pro accounts are served from the daily endpoint
// and Cloud-ToS ones from the main one; both are tried.
const ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']
const WINDOWS: Record<string, { kind: UsageWindow['kind']; minutes: number }> = { '5h': { kind: 'session', minutes: 300 }, weekly: { kind: 'weekly', minutes: 10_080 } }
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Refreshed a minute early, so a token never expires mid-request.
const EARLY_MS = 60_000

const TokenFields = z.looseObject({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  expiry: z.union([z.string(), z.number()]).optional(),
  expires_at: z.union([z.string(), z.number()]).optional(),
  expires_in: z.number().optional()
})

const StoredAuthFile = z.looseObject({
  token: TokenFields.optional(),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  expiry: z.union([z.string(), z.number()]).optional(),
  expires_at: z.union([z.string(), z.number()]).optional(),
  auth_method: z.string().optional(),
  id_token_email: z.string().optional(),
  email: z.string().optional()
})

export type AntigravityCredential = {
  accessToken: string | null
  refreshToken: string | null
  clientId: string | null
  clientSecret: string | null
  expiresAt: number | null
  authMethod: string | null
  email: string | null
}

function parseExpiryMs(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function parseAntigravityCredentialRaw(raw: string | null): AntigravityCredential | null {
  const parsed = StoredAuthFile.safeParse(parseJson(raw)).data
  if (!parsed) return null
  const fields = parsed.token ?? parsed
  const accessToken = fields.access_token ?? parsed.access_token ?? null
  const refreshToken = fields.refresh_token ?? parsed.refresh_token ?? null
  if (!accessToken && !refreshToken) return null
  const clientId = fields.client_id ?? parsed.client_id ?? null
  const clientSecret = fields.client_secret ?? parsed.client_secret ?? null
  const expiresAt = parseExpiryMs(fields.expiry ?? fields.expires_at ?? parsed.expiry ?? parsed.expires_at)
  const email = (parsed.id_token_email ?? parsed.email)?.trim() || null
  return {
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
    expiresAt,
    authMethod: parsed.auth_method ?? null,
    email
  }
}

function defaultHome(): string {
  return process.env.GEMINI_HOME || path.join(homedir(), '.gemini')
}

async function readCredentialForHome(home?: string): Promise<{ resolvedHome: string; credential: AntigravityCredential } | null> {
  const resolvedHome = home ?? defaultHome()
  const raw = await readFile(antigravityCliTokenFile(resolvedHome), 'utf8').catch(() => null)
  const fromFile = parseAntigravityCredentialRaw(raw)
  if (fromFile) return { resolvedHome, credential: fromFile }
  if (isSystemDefaultGeminiHome(home)) {
    const fromKeyring = parseAntigravityCredentialRaw(await runtime.readAntigravityKeyringToken())
    if (fromKeyring) return { resolvedHome, credential: fromKeyring }
  }
  return null
}

// Access tokens live an hour and the CLI refreshes its own only while running; Conclave keeps any
// refreshed access token in memory only and never writes credentials to disk.
const refreshedTokens = new Map<string, { token: string; until: number }>()
const preferredOAuthClients = new Map<string, AntigravityOAuthClient>()

async function oauthClientsFor(credential: AntigravityCredential): Promise<readonly AntigravityOAuthClient[]> {
  if (credential.clientId && credential.clientSecret) {
    return [{ clientId: credential.clientId, clientSecret: credential.clientSecret }]
  }
  const key = credential.authMethod ?? 'default'
  const preferred = preferredOAuthClients.get(key)
  let discovered: readonly AntigravityOAuthClient[] = []
  try {
    discovered = await runtime.readAntigravityOAuthClients()
  } catch {
    discovered = []
  }
  if (!preferred) return discovered
  return [
    preferred,
    ...discovered.filter((entry) => entry.clientId !== preferred.clientId || entry.clientSecret !== preferred.clientSecret)
  ]
}

async function refreshAccessToken(credential: AntigravityCredential, now = Date.now()): Promise<string> {
  if (!credential.refreshToken) {
    throw new UsageFetchError('auth-expired', 'Antigravity token missing refresh_token')
  }
  const clients = await oauthClientsFor(credential)
  if (clients.length === 0) {
    throw new UsageFetchError('request-failed', '无法从本机已安装的 agy CLI 读取 OAuth 客户端，请确认已安装 agy')
  }
  const dispatcher = getProxyDispatcher()
  let lastError: unknown = null
  for (const client of clients) {
    const body = new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: credential.refreshToken,
      grant_type: 'refresh_token'
    })
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000)
    }
    if (dispatcher) Reflect.set(init, 'dispatcher', dispatcher)
    let response: Response
    try {
      response = await fetch(OAUTH_TOKEN_URL, init)
    } catch (error) {
      lastError = new UsageFetchError('request-failed', error instanceof Error ? error.message : String(error))
      continue
    }
    if (response.status === 400 || response.status === 401) {
      lastError = new UsageFetchError('auth-expired', `${OAUTH_TOKEN_URL} answered ${response.status}`)
      continue
    }
    if (!response.ok) {
      lastError = new UsageFetchError('request-failed', `${OAUTH_TOKEN_URL} answered ${response.status}`)
      continue
    }
    const granted = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().default(3600) }).safeParse(await response.json())
    if (!granted.success) {
      lastError = new UsageFetchError('request-failed', 'Google 的令牌响应无法识别')
      continue
    }
    preferredOAuthClients.set(credential.authMethod ?? 'default', client)
    refreshedTokens.set(credential.refreshToken, {
      token: granted.data.access_token,
      until: now + granted.data.expires_in * 1000 - EARLY_MS
    })
    return granted.data.access_token
  }
  throw lastError instanceof Error ? lastError : new UsageFetchError('auth-expired', 'Antigravity token refresh failed')
}

async function resolveAccessToken(credential: AntigravityCredential, forceRefresh = false, now = Date.now()): Promise<string> {
  if (credential.refreshToken) {
    if (forceRefresh) {
      refreshedTokens.delete(credential.refreshToken)
      return refreshAccessToken(credential, now)
    }
    const kept = refreshedTokens.get(credential.refreshToken)
    if (kept && kept.until > now) return kept.token
  }
  const notExpired = credential.accessToken && (credential.expiresAt === null || credential.expiresAt > now + EARLY_MS)
  if (!forceRefresh && notExpired && credential.accessToken) return credential.accessToken
  if (credential.refreshToken) return refreshAccessToken(credential, now)
  if (!forceRefresh && credential.accessToken) return credential.accessToken
  throw new UsageFetchError('auth-expired', 'Antigravity access token expired')
}

async function withRefreshedToken<T>(credential: AntigravityCredential, run: (token: string) => Promise<T>): Promise<T> {
  const token = await resolveAccessToken(credential, false)
  try {
    return await run(token)
  } catch (error) {
    if (error instanceof UsageFetchError && error.code === 'auth-expired' && credential.refreshToken) {
      const fresh = await resolveAccessToken(credential, true)
      return run(fresh)
    }
    throw error
  }
}

async function fetchUserEmailWithToken(token: string): Promise<string | null> {
  const json = await fetchUsageJson('https://www.googleapis.com/oauth2/v3/userinfo', { Authorization: `Bearer ${token}` })
  const data = z.object({ email: z.string().optional() }).safeParse(json).data
  return data?.email?.trim() || null
}

export async function readAntigravityAccountEmail(home?: string): Promise<string | null> {
  const loaded = await readCredentialForHome(home)
  if (!loaded) return null
  if (loaded.credential.email) return loaded.credential.email
  try {
    return await withRefreshedToken(loaded.credential, fetchUserEmailWithToken)
  } catch {
    return null
  }
}

// The structured User-Agent sent to Cloud Code endpoints; CCPA parses the 3rd slash-separated
// token as the client version before returning general Gemini buckets.
export function antigravityUserAgent(platform: NodeJS.Platform = process.platform, arch = process.arch, version = '1.5.6'): string {
  const osType = platform === 'win32' ? 'windows' : platform
  const machine = arch === 'x64' ? 'amd64' : arch
  return `antigravity/acp/${version} (aidev_client; os_type=${osType}; arch=${machine}; host_path=conclave/1; proxy_client=antigravity/sdk)`
}

const Bucket = z.looseObject({
  bucketId: z.string().optional(),
  window: z.string().optional(),
  remainingFraction: z.number().optional(),
  disabled: z.boolean().optional(),
  resetTime: z.string().optional()
})
const Summary = z.looseObject({ groups: z.array(z.looseObject({ displayName: z.string().optional(), buckets: z.array(z.unknown()).catch([]) })).catch([]) })

// One window per bucket with a known span and a remaining fraction. Gemini's are the account's own
// limits; another group (the shared Claude and GPT allotment) is named by its group.
export function parseAntigravityQuota(body: unknown): UsageWindow[] {
  return (Summary.safeParse(body).data?.groups ?? []).flatMap((group) => group.buckets.flatMap((raw) => {
    const bucket = Bucket.safeParse(raw).data
    if (!bucket || bucket.disabled || bucket.remainingFraction === undefined) return []
    const span = WINDOWS[bucket.window ?? ''] ?? WINDOWS[/-(5h|weekly)$/.exec(bucket.bucketId ?? '')?.[1] ?? '']
    if (!span) return []
    const reset = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN
    return [{
      kind: span.kind,
      model: /^gemini-(5h|weekly)$/.test(bucket.bucketId ?? '') ? null : group.displayName ?? null,
      usedPercent: Math.round((1 - Math.min(1, Math.max(0, bucket.remainingFraction))) * 1000) / 10,
      windowMinutes: span.minutes,
      resetsAt: Number.isFinite(reset) ? reset : null
    }]
  }))
}

const LoadCodeAssistResponse = z.looseObject({
  cloudaicompanionProject: z.union([z.string(), z.looseObject({ id: z.string().optional() })]).optional(),
  currentTier: z.looseObject({ name: z.string().optional(), id: z.string().optional() }).optional(),
  paidTier: z.looseObject({ name: z.string().optional(), id: z.string().optional() }).optional()
})

async function resolveProjectAndPlan(token: string, cachedProjectId: string, userAgent: string): Promise<{ projectId: string; plan: string | null }> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': userAgent }
  const body = JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } })
  let authError: unknown = null
  for (const endpoint of ENDPOINTS) {
    try {
      const parsed = LoadCodeAssistResponse.safeParse(await fetchUsageJson(`${endpoint}/v1internal:loadCodeAssist`, headers, body)).data
      if (!parsed) continue
      const loadedProject = typeof parsed.cloudaicompanionProject === 'string'
        ? parsed.cloudaicompanionProject
        : parsed.cloudaicompanionProject?.id ?? ''
      const plan = parsed.paidTier?.name ?? parsed.paidTier?.id ?? parsed.currentTier?.name ?? parsed.currentTier?.id ?? null
      const projectId = loadedProject.trim() || cachedProjectId
      if (projectId || plan) return { projectId, plan }
    } catch (error) {
      if (error instanceof UsageFetchError && error.code === 'auth-expired') authError = error
    }
  }
  if (!cachedProjectId && authError) throw authError
  return { projectId: cachedProjectId, plan: null }
}

async function fetchQuotaWindows(token: string, cachedProjectId: string, userAgent: string): Promise<UsageReading> {
  const { projectId, plan } = await resolveProjectAndPlan(token, cachedProjectId, userAgent)
  if (!projectId) return { signedIn: true, windows: [], plan }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': userAgent }
  const body = JSON.stringify({ project: projectId })
  let failure: unknown = null
  for (const endpoint of ENDPOINTS) {
    try {
      const windows = parseAntigravityQuota(await fetchUsageJson(`${endpoint}/v1internal:retrieveUserQuotaSummary`, headers, body))
      if (windows.length) return { signedIn: true, windows, plan }
    } catch (error) {
      failure = error
    }
  }
  if (failure) throw failure
  return { signedIn: true, windows: [], plan }
}

export async function readAntigravityUsage(home?: string): Promise<UsageReading> {
  const loaded = await readCredentialForHome(home)
  if (loaded) {
    const projectFile = path.join(loaded.resolvedHome, 'antigravity-cli', 'cache', 'default_project_id.txt')
    const cachedProjectId = (await readFile(projectFile, 'utf8').catch(() => '')).trim()
    const version = await runtime.antigravityCliVersion().catch(() => null)
    const userAgent = antigravityUserAgent(process.platform, process.arch, version ?? '1.5.6')
    return withRefreshedToken(loaded.credential, (token) => fetchQuotaWindows(token, cachedProjectId, userAgent))
  }
  if (await runtime.antigravityHomeSignedIn(home)) {
    return { signedIn: true, windows: [], plan: null }
  }
  return { signedIn: false }
}
