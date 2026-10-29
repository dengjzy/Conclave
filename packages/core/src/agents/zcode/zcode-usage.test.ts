import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseZCodeQuota, readZCodeUsage, zcodePlanKey } from './zcode-usage'

const providers = (rules: object[], providerId: string) => ({ schemaVersion: 1, config: { providerConfigRules: { providerRules: rules }, defaultModelSelection: { providerId, modelId: 'glm-5.3' } } })
const plan = { providerId: 'plan', templateId: 'zai-api', enabled: true, config: { access: { type: 'zhipu-coding-plan-api-key', apiKey: 'zk-plan' } } }
const custom = { providerId: 'mine', config: { access: { type: 'api-key', apiKey: 'sk-other' }, api: { type: 'openai-chat-completions', baseUrl: 'https://api.example.com/v1' } } }
const quota = { code: 200, msg: 'ok', success: true, data: { level: 'pro', limits: [
  { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 1000, currentValue: 250, remaining: 750, nextResetTime: 1_800_000_000_000 },
  { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40, nextResetTime: 1_800_500_000_000 },
  { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 10 },
  { type: 'TOKENS_LIMIT', unit: 9, number: 1, percentage: 5 }
] } }

let home: string
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'conclave-zcode-usage-')) })
afterEach(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }) })

describe('Z.ai plan usage', () => {
  it('takes the key of the provider ZCode runs on, and only a Z.ai or BigModel one', () => {
    expect(zcodePlanKey(providers([custom, plan], 'plan'), null)).toEqual({ origin: 'https://api.z.ai', apiKey: 'zk-plan' })
    expect(zcodePlanKey(providers([{ ...plan, templateId: 'bigmodel-api' }], 'plan'), null)).toEqual({ origin: 'https://open.bigmodel.cn', apiKey: 'zk-plan' })
    expect(zcodePlanKey(providers([{ providerId: 'p', config: { access: { apiKey: 'k' }, api: { baseUrl: 'https://open.bigmodel.cn/api/anthropic' } } }], 'p'), null)).toEqual({ origin: 'https://open.bigmodel.cn', apiKey: 'k' })
    // Another account's quota is never read as this one's.
    expect(zcodePlanKey(providers([custom, plan], 'mine'), null)).toBeNull()
    expect(zcodePlanKey(providers([{ ...plan, config: { access: { apiKey: '' } } }], 'plan'), null)).toBeNull()
  })

  it('reads the older settings where there is no provider file', () => {
    const legacy = { model: 'zai/glm-5.3', provider: { zai: { options: { apiKey: 'old', baseURL: 'https://api.z.ai/api/anthropic' } }, other: { options: { apiKey: 'x', baseURL: 'http://api.z.ai' } } } }
    expect(zcodePlanKey(null, legacy)).toEqual({ origin: 'https://api.z.ai', apiKey: 'old' })
    expect(zcodePlanKey(null, { ...legacy, model: { main: 'other/glm' } })).toBeNull()
  })

  it('reads the 5-hour, weekly and monthly windows, leaving one it cannot place', () => {
    expect(parseZCodeQuota(quota)).toEqual({ plan: 'pro', windows: [
      { kind: 'session', model: null, usedPercent: 25, windowMinutes: 300, resetsAt: 1_800_000_000_000 },
      { kind: 'weekly', model: null, usedPercent: 40, windowMinutes: 10_080, resetsAt: 1_800_500_000_000 },
      { kind: 'monthly', model: null, usedPercent: 10, windowMinutes: 43_200, resetsAt: null }
    ] })
    expect(() => parseZCodeQuota({ code: 1001, msg: 'invalid key', success: false })).toThrow('invalid key')
  })

  it('asks the plan host with the key, and reads as signed out without one', async () => {
    expect(await readZCodeUsage(home, {})).toEqual({ signedIn: false })
    mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true })
    writeFileSync(path.join(home, '.zcode', 'v2', 'provider_config.json'), JSON.stringify(providers([plan], 'plan')))
    const fetch = vi.fn(async () => new Response(JSON.stringify(quota), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await readZCodeUsage(home, {})).toMatchObject({ signedIn: true, plan: 'pro', windows: [{ kind: 'session' }, { kind: 'weekly' }, { kind: 'monthly' }] })
    expect(fetch).toHaveBeenCalledWith('https://api.z.ai/api/monitor/usage/quota/limit', expect.objectContaining({ headers: { Authorization: 'zk-plan', 'Accept-Language': 'en-US,en' } }))
  })
})
