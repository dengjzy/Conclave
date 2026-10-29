import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { antigravityTokenFile } from './antigravity-runtime'
import { antigravityUserAgent, parseAntigravityQuota, readAntigravityUsage } from './antigravity-usage'

// Shaped as CCPA's QuotaSummaryGroup / QuotaSummaryBucket, per the discovery document in 1.4.1.
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
    { displayName: 'Info only' }
  ]
}

describe('Antigravity usage', () => {
  let home: string
  let token: string
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'conclave-antigravity-usage-'))
    vi.stubEnv('GEMINI_HOME', home)
    token = antigravityTokenFile()
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await rm(home, { recursive: true, force: true })
  })
  const signIn = async (credential: Record<string, unknown>) => {
    await mkdir(path.dirname(token), { recursive: true })
    await writeFile(token, JSON.stringify(credential))
  }
  const credential = { client_id: 'client', client_secret: 'secret', refresh_token: `refresh-${Math.random()}`, token_uri: 'https://oauth2.googleapis.com/token', scopes: [], project_id: 'project-1' }

  it('reads each window, Gemini as the account’s own and the shared allotment by its group', () => {
    expect(parseAntigravityQuota(summary)).toEqual([
      { kind: 'session', model: null, usedPercent: 25, windowMinutes: 300, resetsAt: Date.parse('2026-10-22T12:00:00Z') },
      { kind: 'weekly', model: null, usedPercent: 8.8, windowMinutes: 10_080, resetsAt: Date.parse('2026-10-27T00:00:00Z') },
      { kind: 'session', model: 'Claude and GPT Models', usedPercent: 0, windowMinutes: 300, resetsAt: null }
    ])
    expect(parseAntigravityQuota({ groups: 'nope' })).toEqual([])
  })

  it('names Conclave the way the server names its client', () => {
    expect(antigravityUserAgent('darwin', 'x64')).toBe('antigravity/acp/1.4.1 (aidev_client; os_type=darwin; arch=amd64; host_path=conclave/1; proxy_client=antigravity/sdk)')
  })

  it('is signed out without the server’s token file', async () => {
    expect(await readAntigravityUsage()).toEqual({ signedIn: false })
  })

  it('refreshes a token in memory, asks the daily endpoint first, then the main one', async () => {
    await signIn(credential)
    const before = await readFile(token, 'utf8')
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url === credential.token_uri) return Response.json({ access_token: 'access', expires_in: 3600 })
      if (url.startsWith('https://daily-')) return new Response('down', { status: 503 })
      return Response.json(summary)
    }))
    const reading = await readAntigravityUsage()
    expect(reading).toMatchObject({ signedIn: true, plan: null })
    expect(reading.signedIn && reading.windows).toHaveLength(3)
    expect(String(calls[0]?.init.body)).toContain('grant_type=refresh_token')
    expect(calls.slice(1).map((call) => call.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
    ])
    expect(calls[1]?.init.body).toBe('{"project":"project-1"}')
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe('Bearer access')
    // A second read reuses the token, and the saved sign-in is never rewritten.
    await readAntigravityUsage()
    expect(calls.filter((call) => call.url === credential.token_uri)).toHaveLength(1)
    expect(await readFile(token, 'utf8')).toBe(before)
  })

  it('reports a sign-in Google no longer refreshes as expired', async () => {
    await signIn({ ...credential, refresh_token: 'revoked' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })))
    await expect(readAntigravityUsage()).rejects.toMatchObject({ code: 'auth-expired' })
  })
})
