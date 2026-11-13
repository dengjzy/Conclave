import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as runtime from './antigravity-runtime'
import { antigravityCliTokenFile } from './antigravity-runtime'
import { antigravityUserAgent, parseAntigravityQuota, readAntigravityAccountEmail, readAntigravityUsage } from './antigravity-usage'

// Shaped as CCPA's QuotaSummaryGroup / QuotaSummaryBucket.
const summary = {
  groups: [
    { displayName: 'Gemini Models', buckets: [
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: '2026-10-22T12:00:00Z' },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.912, resetTime: '2026-10-27T00:00:00Z' }
    ] },
    { displayName: 'Claude and GPT Models', buckets: [
      { bucketId: '3p-5h', remainingFraction: 1 },
      { bucketId: '3p-weekly', window: 'weekly', disabled: true, description: 'Upgrade to use' }
    ] },
    { displayName: 'Gemini 4 Argon', buckets: [
      { bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-10-28T00:00:00Z' }
    ] },
    { displayName: 'Info only' }
  ]
}

describe('Antigravity usage', () => {
  let home: string
  let token: string
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'conclave-antigravity-usage-'))
    vi.stubEnv('GEMINI_HOME', home)
    vi.spyOn(runtime, 'antigravityCliVersion').mockResolvedValue('1.5.6')
    vi.spyOn(runtime, 'readAntigravityOAuthClients').mockResolvedValue([
      { clientId: 'test-cli-client-id', clientSecret: 'test-cli-client-secret' }
    ])
    token = antigravityCliTokenFile()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await rm(home, { recursive: true, force: true })
  })
  const signIn = async (credential: Record<string, unknown>) => {
    await mkdir(path.dirname(token), { recursive: true })
    await writeFile(token, JSON.stringify(credential))
  }
  const nestedToken = (refresh = `refresh-${Math.random()}`, overrides: Record<string, unknown> = {}) => ({
    token: {
      access_token: 'stale-access',
      token_type: 'Bearer',
      refresh_token: refresh,
      expiry: '2020-01-01T00:00:00Z',
      expires_in: 3599
    },
    auth_method: 'consumer',
    id_token_email: 'user@example.com',
    ...overrides
  })

  it('reads each window, Gemini as the account’s own and the shared allotment by its group', () => {
    expect(parseAntigravityQuota(summary)).toEqual([
      { kind: 'session', model: null, usedPercent: 25, windowMinutes: 300, resetsAt: Date.parse('2026-10-22T12:00:00Z') },
      { kind: 'weekly', model: null, usedPercent: 8.8, windowMinutes: 10_080, resetsAt: Date.parse('2026-10-27T00:00:00Z') },
      { kind: 'session', model: 'Claude and GPT Models', usedPercent: 0, windowMinutes: 300, resetsAt: null },
      { kind: 'weekly', model: 'Gemini 4 Argon', usedPercent: 10, windowMinutes: 10_080, resetsAt: Date.parse('2026-10-28T00:00:00Z') }
    ])
    expect(parseAntigravityQuota({ groups: 'nope' })).toEqual([])
  })

  it('names Conclave with the agy CLI User-Agent format', () => {
    expect(antigravityUserAgent('darwin', 'x64')).toBe('antigravity/acp/1.5.6 (aidev_client; os_type=darwin; arch=amd64; host_path=conclave/1; proxy_client=antigravity/sdk)')
  })

  it('is signed out without the CLI token file', async () => {
    expect(await readAntigravityUsage()).toEqual({ signedIn: false })
  })

  it('refreshes nested agy 1.5+ OAuth tokens in memory, resolves project and plan via loadCodeAssist, and falls back across quota endpoints', async () => {
    await signIn(nestedToken())
    const before = await readFile(token, 'utf8')
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fresh-access', expires_in: 3600 })
      if (url.endsWith('/v1internal:loadCodeAssist')) {
        return Response.json({ cloudaicompanionProject: 'project-156', currentTier: { id: 'standard', name: 'Free' }, paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } })
      }
      if (url.startsWith('https://daily-')) return new Response('down', { status: 503 })
      return Response.json(summary)
    }))
    const reading = await readAntigravityUsage()
    expect(reading).toMatchObject({ signedIn: true, plan: 'Google AI Pro' })
    expect(reading.signedIn && reading.windows).toHaveLength(4)
    expect(String(calls[0]?.init.body)).toContain('grant_type=refresh_token')
    expect(String(calls[0]?.init.body)).toContain('client_id=test-cli-client-id')
    expect(calls.slice(1).map((call) => call.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
    ])
    expect(calls[2]?.init.body).toBe('{"project":"project-156"}')
    expect(new Headers(calls[2]?.init.headers).get('authorization')).toBe('Bearer fresh-access')
    // A second read reuses the refreshed token in memory, and the saved sign-in is never rewritten.
    await readAntigravityUsage()
    expect(calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token')).toHaveLength(1)
    expect(await readFile(token, 'utf8')).toBe(before)
  })

  it('reads id_token_email directly and falls back to userinfo when absent', async () => {
    await signIn(nestedToken())
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await readAntigravityAccountEmail()).toBe('user@example.com')
    expect(fetchSpy).not.toHaveBeenCalled()

    await signIn(nestedToken(`refresh-${Math.random()}`, { id_token_email: '' }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'email-access', expires_in: 3600 })
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') return Response.json({ email: 'fallback@example.com' })
      return new Response('unexpected', { status: 500 })
    }))
    expect(await readAntigravityAccountEmail()).toBe('fallback@example.com')
  })

  it('reports a sign-in Google no longer refreshes as expired', async () => {
    await signIn(nestedToken('revoked'))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })))
    await expect(readAntigravityUsage()).rejects.toMatchObject({ code: 'auth-expired' })
  })

  it('falls back to the OS keyring for the default account when no token file exists', async () => {
    vi.spyOn(runtime, 'isSystemDefaultGeminiHome').mockReturnValue(true)
    vi.spyOn(runtime, 'readAntigravityKeyringToken').mockResolvedValue(JSON.stringify(nestedToken(`keyring-${Math.random()}`)))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'keyring-access', expires_in: 3600 })
      if (url.endsWith('/v1internal:loadCodeAssist')) {
        return Response.json({ cloudaicompanionProject: 'keyring-proj', paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } })
      }
      return Response.json(summary)
    }))
    expect(await readAntigravityAccountEmail()).toBe('user@example.com')
    const reading = await readAntigravityUsage()
    expect(reading).toMatchObject({ signedIn: true, plan: 'Google AI Ultra' })
    expect(reading.signedIn && reading.windows).toHaveLength(4)
  })
})
