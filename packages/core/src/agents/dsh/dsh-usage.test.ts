import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '@conclave/protocol'
import type { ResolvedModelProvider } from '../../model-providers'
import { parseDshBalance, readDshUsage } from './dsh-usage'

const ENDPOINT = 'https://api.deepseek.com/user/balance'
const KEY = 'sk-dsh-fixture-secret'
const response = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '465.46', granted_balance: '5.46', topped_up_balance: '460.00' }]
}
const source = { id: 'official', name: 'DeepSeek 工作账号' }
const provider = (apiKey: string, changes: Partial<ModelProvider> = {}): ResolvedModelProvider => ({
  apiKey,
  provider: {
    id: 'official', name: source.name, preset: 'custom', anthropic: null,
    openai: { chatUrl: 'https://api.deepseek.com/v1', responsesUrl: null },
    models: [{ id: 'deepseek-chat', label: null, contextWindow: null, maxOutput: null, efforts: [] }],
    defaultModel: 'deepseek-chat', smallModel: 'deepseek-chat', agents: ['dsh'],
    hasKey: true, revision: 1, createdAt: 0, updatedAt: 0, ...changes
  }
})

describe('DSH balance', () => {
  let home: string
  const fetch = vi.fn<typeof globalThis.fetch>()
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'conclave-dsh-usage-'))
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    fetch.mockReset().mockImplementation(async () => Response.json(response))
    vi.stubGlobal('fetch', fetch)
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })
  const credentials = (key: string) => writeFile(path.join(home, '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n`)
  const requestedKeys = () => fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))

  it('does not query when no DeepSeek credentials are configured', async () => {
    expect(await readDshUsage()).toEqual({ signedIn: false })
    expect(fetch).not.toHaveBeenCalled()
    expect(await readdir(home)).toEqual([])
  })

  it('resolves managed credentials before the environment and the home dotenv file, without changing them', async () => {
    const file = path.join(home, '.credentials.yaml')
    const dotenv = path.join(home, '.env')
    await credentials(KEY)
    await writeFile(dotenv, 'export DEEPSEEK_API_KEY="sk-home-fixture"\n')
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-environment-fixture')
    const before = await readFile(file, 'utf8')
    const beforeEnv = await readFile(dotenv, 'utf8')

    const reading = await readDshUsage()
    expect(reading).toMatchObject({ signedIn: true, windows: [], balances: [{ id: 'dsh:deepseek:CNY', name: 'DeepSeek', total: 465.46 }] })
    expect(requestedKeys()).toEqual([`Bearer ${KEY}`])
    expect(JSON.stringify(reading)).not.toContain(KEY)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readFile(dotenv, 'utf8')).toBe(beforeEnv)

    await rm(file)
    await readDshUsage()
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    await readDshUsage()
    expect(requestedKeys()).toEqual([`Bearer ${KEY}`, 'Bearer sk-environment-fixture', 'Bearer sk-home-fixture'])
    expect(await readdir(home)).toEqual(['.env'])
    expect(await readFile(dotenv, 'utf8')).toBe(beforeEnv)
  })

  it.each(['', '# no saved API keys\n', '{}\n', 'version: 1\nrecords: {}\n', 'version: 1\nrefs: {}\n', 'version: 1\nrefs: null\n'])('uses fallback credentials for a valid empty managed store %j', async (raw) => {
    const file = path.join(home, '.credentials.yaml')
    await writeFile(file, raw)
    expect(await readDshUsage()).toEqual({ signedIn: false })
    expect(fetch).not.toHaveBeenCalled()
    vi.stubEnv('DEEPSEEK_API_KEY', KEY)
    await readDshUsage()
    expect(requestedKeys()).toEqual([`Bearer ${KEY}`])
    expect(await readFile(file, 'utf8')).toBe(raw)
  })

  it('reads official Conclave providers and deduplicates keys also configured in DSH', async () => {
    await credentials(KEY)
    const reading = await readDshUsage(undefined, [
      provider(KEY),
      provider(KEY, { id: 'duplicate', name: 'Same account' }),
      provider('sk-second-fixture', { id: 'second', name: 'DeepSeek 个人账号', openai: null, anthropic: { baseUrl: 'https://api.deepseek.com/anthropic', auth: 'api_key', env: {} } })
    ])
    expect(reading).toMatchObject({ signedIn: true, windows: [], balances: [
      { id: 'official:CNY', name: source.name, total: 465.46 },
      { id: 'second:CNY', name: 'DeepSeek 个人账号', total: 465.46 }
    ] })
    expect(requestedKeys()).toEqual([`Bearer ${KEY}`, 'Bearer sk-second-fixture'])
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(ENDPOINT)
      expect(init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
      expect(new Headers(init?.headers).get('accept')).toBe('application/json')
    }
    expect(JSON.stringify(reading)).not.toContain('sk-')
  })

  it('hides the DSH key when it is another key of a provider account already shown', async () => {
    await credentials('sk-native-fixture')
    fetch.mockImplementation(async (_url, init) => {
      const authorization = new Headers(init?.headers).get('authorization')
      const total = authorization === 'Bearer sk-other-fixture' ? '3.00' : '11.06'
      return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0', topped_up_balance: total }] })
    })
    const reading = await readDshUsage(undefined, [
      provider(KEY, { id: 'custom', name: 'DeepSeek' }),
      provider('sk-other-fixture', { id: 'other', name: 'DeepSeek 备用' })
    ])
    expect(reading).toMatchObject({ balances: [
      { id: 'custom:CNY', name: 'DeepSeek', total: 11.06 },
      { id: 'other:CNY', name: 'DeepSeek 备用', total: 3 }
    ] })
    expect(requestedKeys()).toEqual([`Bearer ${KEY}`, 'Bearer sk-other-fixture', 'Bearer sk-native-fixture'])
  })

  it('keeps the DSH key when its balance is a different account', async () => {
    await credentials('sk-native-fixture')
    fetch.mockImplementation(async (_url, init) => {
      const total = new Headers(init?.headers).get('authorization') === 'Bearer sk-native-fixture' ? '2.00' : '11.06'
      return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0', topped_up_balance: total }] })
    })
    const reading = await readDshUsage(undefined, [provider(KEY, { id: 'custom', name: 'DeepSeek' })])
    expect(reading).toMatchObject({ balances: [
      { id: 'custom:CNY', name: 'DeepSeek', total: 11.06 },
      { id: 'dsh:deepseek:CNY', name: 'DeepSeek', total: 2 }
    ] })
  })

  it('recognizes an official Responses endpoint', async () => {
    await readDshUsage(undefined, [provider(KEY, { openai: { chatUrl: null, responsesUrl: 'https://api.deepseek.com/v1' } })])
    expect(requestedKeys()).toEqual([`Bearer ${KEY}`])
  })

  it('does not return a partial snapshot as fresh when another provider fails', async () => {
    fetch.mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(new Response(null, { status: 401 }))
    await expect(readDshUsage(undefined, [provider(KEY), provider('sk-second-fixture', { id: 'second' })])).rejects.toMatchObject({ code: 'api-key-rejected' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    'https://api.deepseek.com.attacker.example/v1',
    'https://proxy.example/api.deepseek.com',
    'https://api.deepseek.com@attacker.example/v1',
    'https://someone@api.deepseek.com/v1',
    'http://api.deepseek.com/v1',
    'https://api.deepseek.com:8443/v1',
    'not-a-url'
  ])('does not send a provider key to the balance endpoint for %s', async (chatUrl) => {
    expect(await readDshUsage(undefined, [provider(KEY, { openai: { chatUrl, responsesUrl: null } })])).toEqual({ signedIn: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps currency and availability explicit, including zero and negative balances', () => {
    expect(parseDshBalance({ is_available: false, balance_infos: [
      { currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0' },
      { currency: 'USD', total_balance: '-0.01', granted_balance: '0', topped_up_balance: '-0.01' }
    ] }, source)).toEqual([
      { id: 'official:CNY', name: source.name, currency: 'CNY', total: 0, granted: 0, toppedUp: 0, available: false },
      { id: 'official:USD', name: source.name, currency: 'USD', total: -0.01, granted: 0, toppedUp: -0.01, available: false }
    ])
  })

  it.each(['', 'NaN', 'Infinity', '1e3', '12 dollars', '9'.repeat(400), 12, null])('rejects malformed money %j without returning a fabricated balance', (total_balance) => {
    expect(() => parseDshBalance({ ...response, balance_infos: [{ ...response.balance_infos[0], total_balance }] }, source)).toThrow('Invalid DeepSeek balance response')
  })

  it('rejects empty, duplicated and unknown currencies', () => {
    for (const balance_infos of [[], [...response.balance_infos, ...response.balance_infos], [{ ...response.balance_infos[0], currency: 'EUR' }]]) {
      expect(() => parseDshBalance({ ...response, balance_infos }, source)).toThrow('Invalid DeepSeek balance response')
    }
  })

  it.each([401, 403])('reports rejected credentials (%s) as api-key-rejected without exposing the response', async (status) => {
    vi.stubEnv('DEEPSEEK_API_KEY', KEY)
    fetch.mockResolvedValue(new Response(`rejected ${KEY}`, { status }))
    await expect(readDshUsage()).rejects.toMatchObject({ code: 'api-key-rejected', message: 'DeepSeek API key was rejected' })
  })

  it('redacts network errors, invalid JSON and malformed responses', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', KEY)
    fetch.mockRejectedValueOnce(new Error(`failed to send Bearer ${KEY}`))
    await expect(readDshUsage()).rejects.toMatchObject({ code: 'request-failed', message: 'DeepSeek balance request failed' })
    fetch.mockResolvedValueOnce(new Response(`{"key":"${KEY}"`))
    await expect(readDshUsage()).rejects.toMatchObject({ code: 'request-failed', message: 'Invalid DeepSeek balance response' })
    fetch.mockResolvedValueOnce(Response.json({ ...response, balance_infos: [{ ...response.balance_infos[0], total_balance: KEY }] }))
    await expect(readDshUsage()).rejects.toMatchObject({ code: 'request-failed', message: 'Invalid DeepSeek balance response' })
    fetch.mockResolvedValueOnce(new Response(`server echoed ${KEY}`, { status: 503 }))
    await expect(readDshUsage()).rejects.toMatchObject({ code: 'request-failed', message: 'DeepSeek balance endpoint answered 503' })
  })

  it.each([
    `version: 1\nrefs:\n  DEEPSEEK_API_KEY: [${KEY}\n`,
    `version: 99\nrefs:\n  DEEPSEEK_API_KEY: ${KEY}\n`,
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: 123\n',
    `version: 1\nrefs:\n  DEEPSEEK_API_KEY: !!js ${KEY}\n`
  ])('rejects malformed credential files without leaking their content or falling back to another account', async (raw) => {
    const file = path.join(home, '.credentials.yaml')
    await writeFile(file, raw)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-environment-fixture')
    await expect(readDshUsage()).rejects.toMatchObject({ code: 'request-failed', message: 'Invalid DSH credentials file' })
    expect(fetch).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe(raw)
  })
})
