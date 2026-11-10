import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseGrokBilling, readGrokUsage } from './grok-usage'

const BILLING = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const TOKEN = 'https://auth.x.ai/oauth2/token'
const billing = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-10T07:05:13.726Z' },
    creditUsagePercent: 55,
    productUsage: [
      { product: 'GrokBot', usagePercent: 32 },
      { product: 'GrokImagine', usagePercent: 22 },
      { product: ' ', usagePercent: 90 }
    ]
  }
}
const auth = (extra: Record<string, unknown> = {}) => JSON.stringify({
  'https://auth.x.ai::client': {
    key: 'access-fixture',
    refresh_token: 'refresh-fixture',
    expires_at: '2099-01-01T00:00:00Z',
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'client-fixture',
    email: 'person@example.com',
    ...extra
  }
})

describe('Grok usage', () => {
  let home: string
  const fetch = vi.fn<typeof globalThis.fetch>()
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'conclave-grok-usage-'))
    vi.stubEnv('GROK_HOME', home)
    fetch.mockReset().mockImplementation(async () => Response.json(billing))
    vi.stubGlobal('fetch', fetch)
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('does not query when Grok is signed out', async () => {
    expect(await readGrokUsage()).toEqual({ signedIn: false })
    await writeFile(path.join(home, 'auth.json'), '{}\n')
    expect(await readGrokUsage()).toEqual({ signedIn: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads the weekly subscription quota and leaves product rows for the card', async () => {
    await writeFile(path.join(home, 'auth.json'), auth())
    const reading = await readGrokUsage()
    expect(reading).toEqual({
      signedIn: true,
      plan: null,
      windows: [
        { kind: 'weekly', model: null, usedPercent: 55, windowMinutes: 7 * 24 * 60, resetsAt: Date.parse('2026-11-10T07:05:13.726Z') },
        { kind: 'weekly', model: 'GrokBot', usedPercent: 32, windowMinutes: 7 * 24 * 60, resetsAt: Date.parse('2026-11-10T07:05:13.726Z') },
        { kind: 'weekly', model: 'GrokImagine', usedPercent: 22, windowMinutes: 7 * 24 * 60, resetsAt: Date.parse('2026-11-10T07:05:13.726Z') }
      ]
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(BILLING)
    expect(init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer access-fixture')
    expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli')
    expect(JSON.stringify(reading)).not.toContain('access-fixture')
    expect(JSON.stringify(reading)).not.toContain('person@example.com')
  })

  it('refreshes an expired login without sending the refresh token anywhere but xAI', async () => {
    await writeFile(path.join(home, 'auth.json'), auth({ key: 'stale-fixture', expires_at: '2000-01-01T00:00:00Z' }))
    fetch.mockImplementation(async (url) => url === TOKEN
      ? Response.json({ access_token: 'fresh-fixture', expires_in: 3600 })
      : Response.json(billing))
    await readGrokUsage()
    await readGrokUsage()
    const tokenCalls = fetch.mock.calls.filter(([url]) => url === TOKEN)
    expect(tokenCalls).toHaveLength(1)
    expect(String(tokenCalls[0]?.[1]?.body)).toContain('refresh_token=refresh-fixture')
    expect(tokenCalls[0]?.[0]).toBe(TOKEN)
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe('Bearer fresh-fixture')

    fetch.mockClear()
    await writeFile(path.join(home, 'auth.json'), auth({ oidc_issuer: 'https://attacker.example', expires_at: '2000-01-01T00:00:00Z', key: 'still-fixture' }))
    await readGrokUsage()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([BILLING])
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer still-fixture')
  })

  it('clamps a percent and rejects a body that is not a billing config', () => {
    expect(parseGrokBilling({ config: { creditUsagePercent: 140.04, productUsage: [{ product: 'GrokBot', usagePercent: -3 }] } })).toMatchObject([
      { model: null, usedPercent: 100 },
      { model: 'GrokBot', usedPercent: 0 }
    ])
    expect(() => parseGrokBilling({ creditUsagePercent: 10 })).toThrow('Grok 的额度响应无法识别')
  })

  it('reports an expired session without returning the response body', async () => {
    await writeFile(path.join(home, 'auth.json'), auth())
    fetch.mockResolvedValue(new Response('token access-fixture rejected', { status: 401 }))
    await expect(readGrokUsage()).rejects.toMatchObject({ code: 'auth-expired', message: 'Grok 登录已过期，请在终端重新登录' })
  })
})
