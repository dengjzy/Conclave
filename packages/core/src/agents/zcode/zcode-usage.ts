import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { UsageWindow } from '@conclave/protocol'
import { fetchUsageJson, parseJson, UsageFetchError, type UsageReading } from '../../usage-source'
import { zcodeHome } from './zcode-cli'

// The GLM Coding Plan's quota, as Z.ai's console and ZCode's own usage panel read it: one GET with
// the plan's API key, from the host the key belongs to. A ZCode account sign-in (zcode login) keeps
// its token encrypted, which Conclave leaves alone: only a key the user set up is used.
const HOSTS: Readonly<Record<string, string>> = { 'api.z.ai': 'https://api.z.ai', 'open.bigmodel.cn': 'https://open.bigmodel.cn', 'dev.bigmodel.cn': 'https://dev.bigmodel.cn' }
// Coding-plan templates ZCode's provider file names instead of an address.
const TEMPLATES: Readonly<Record<string, string>> = { 'zai-api': 'https://api.z.ai', 'bigmodel-api': 'https://open.bigmodel.cn' }

const Rule = z.looseObject({
  providerId: z.string(),
  templateId: z.string().nullish(),
  enabled: z.boolean().optional(),
  config: z.looseObject({
    access: z.looseObject({ apiKey: z.string().optional() }).nullish(),
    api: z.looseObject({ baseUrl: z.string().optional() }).nullish()
  }).catch({})
})
const ProviderFile = z.looseObject({
  config: z.looseObject({
    providerConfigRules: z.looseObject({ providerRules: z.array(z.unknown()).catch([]) }).optional(),
    defaultModelSelection: z.looseObject({ providerId: z.string() }).nullish()
  }).optional()
})
// ZCode's older settings: model as provider/model, each provider's key and address under options.
const LegacyFile = z.looseObject({
  model: z.union([z.string(), z.looseObject({ main: z.string().optional() })]).optional(),
  provider: z.record(z.string(), z.looseObject({ options: z.looseObject({ apiKey: z.string().optional(), baseURL: z.string().optional() }).optional() })).optional()
})

export type ZCodePlanKey = { origin: string; apiKey: string }

function origin(address: string | undefined): string | null {
  if (!address) return null
  try {
    const url = new URL(address)
    return url.protocol === 'https:' && (url.port === '' || url.port === '443') ? HOSTS[url.hostname] ?? null : null
  } catch {
    return null
  }
}

const usable = (key: string | undefined): key is string => Boolean(key?.trim()) && !/[\r\n]/.test(key ?? '')

// The plan key of the provider ZCode runs on by default: a quota of another account the user also
// set up must not read as this one's.
export function zcodePlanKey(providers: unknown, legacy: unknown): ZCodePlanKey | null {
  const file = ProviderFile.safeParse(providers).data?.config
  const rules = (file?.providerConfigRules?.providerRules ?? []).flatMap((raw) => { const rule = Rule.safeParse(raw); return rule.success ? [rule.data] : [] })
  const chosen = file?.defaultModelSelection?.providerId
  if (rules.length && chosen) {
    const rule = rules.find((each) => each.providerId === chosen && each.enabled !== false)
    const key = rule?.config.access?.apiKey
    const host = rule ? origin(rule.config.api?.baseUrl ?? undefined) ?? (rule.templateId ? TEMPLATES[rule.templateId] ?? null : null) : null
    return host && usable(key) ? { origin: host, apiKey: key.trim() } : null
  }
  const old = LegacyFile.safeParse(legacy).data
  const model = typeof old?.model === 'string' ? old.model : old?.model?.main
  const provider = model?.includes('/') ? model.slice(0, model.indexOf('/')) : null
  const options = provider ? old?.provider?.[provider]?.options : undefined
  const host = origin(options?.baseURL)
  return host && usable(options?.apiKey) ? { origin: host, apiKey: options.apiKey.trim() } : null
}

const Limit = z.looseObject({
  type: z.string(),
  unit: z.number().optional(),
  number: z.number().optional(),
  usage: z.number().optional(),
  currentValue: z.number().optional(),
  remaining: z.number().optional(),
  percentage: z.number().optional(),
  nextResetTime: z.number().optional()
})
const Quota = z.looseObject({
  success: z.boolean().optional(),
  code: z.number().optional(),
  msg: z.string().optional(),
  data: z.looseObject({ level: z.string().optional(), limits: z.array(z.unknown()).catch([]) }).optional()
})

// Its window in minutes: unit 1 is days, 3 hours, 5 minutes, 6 weeks; the monthly MCP allowance
// (TIME_LIMIT) says one minute.
function minutesOf(limit: z.infer<typeof Limit>): number | null {
  if (limit.type === 'TIME_LIMIT') return 30 * 24 * 60
  const per: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10_080 }
  const multiplier = limit.unit === undefined ? undefined : per[limit.unit]
  return multiplier && limit.number && Number.isInteger(limit.number) && limit.number > 0 ? limit.number * multiplier : null
}

function usedOf(limit: z.infer<typeof Limit>): number | null {
  if (limit.usage && limit.usage > 0 && (limit.currentValue !== undefined || limit.remaining !== undefined)) {
    const used = limit.currentValue ?? limit.usage - (limit.remaining ?? 0)
    return Math.min(100, Math.max(0, (used / limit.usage) * 100))
  }
  return limit.percentage === undefined ? null : Math.min(100, Math.max(0, limit.percentage))
}

export function parseZCodeQuota(raw: unknown): { windows: UsageWindow[]; plan: string | null } {
  const quota = Quota.safeParse(raw).data
  if (!quota?.data || quota.success === false || (quota.code !== undefined && quota.code !== 0 && quota.code !== 200)) {
    throw new UsageFetchError('request-failed', quota?.msg ?? 'Z.ai 的额度响应无法识别')
  }
  const windows = quota.data.limits.flatMap((raw): UsageWindow[] => {
    const limit = Limit.safeParse(raw).data
    if (!limit) return []
    const minutes = minutesOf(limit)
    const used = usedOf(limit)
    const kind = limit.type === 'TIME_LIMIT' ? 'monthly' : minutes === 300 ? 'session' : minutes === 10_080 ? 'weekly' : null
    if (minutes === null || used === null || kind === null) return []
    const reset = limit.nextResetTime && limit.nextResetTime > 0 ? limit.nextResetTime : null
    return [{ kind, model: null, usedPercent: used, windowMinutes: minutes, resetsAt: reset }]
  })
  return { windows, plan: quota.data.level ?? null }
}

export async function readZCodeUsage(home?: string, env: NodeJS.ProcessEnv = process.env): Promise<UsageReading> {
  const dir = zcodeHome(home)
  const read = (file: string) => readFile(file, 'utf8').then((text) => parseJson(text), () => null)
  const [providers, legacy] = await Promise.all([
    read(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() || path.join(dir, 'v2', 'provider_config.json')),
    read(path.join(dir, 'cli', 'config.json'))
  ])
  const key = zcodePlanKey(providers, legacy)
  if (!key) return { signedIn: false }
  const quota = await fetchUsageJson(`${key.origin}/api/monitor/usage/quota/limit`, { Authorization: key.apiKey, 'Accept-Language': 'en-US,en' })
  return { signedIn: true, ...parseZCodeQuota(quota) }
}
