import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { UsageBalance } from '@conclave/protocol'
import type { ResolvedModelProvider } from '../../model-providers'
import { UsageFetchError, type UsageReading } from '../../usage-source'

const ENDPOINT = 'https://api.deepseek.com/user/balance'
const Amount = z.string().trim().regex(/^-?\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite())
const BalanceResponse = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({
    currency: z.enum(['CNY', 'USD']),
    total_balance: Amount,
    granted_balance: Amount,
    topped_up_balance: Amount
  })).min(1)
})
const Credentials = z.object({ version: z.literal(1), refs: z.record(z.string(), z.string()).nullish().transform((refs) => refs ?? {}) })
type BalanceSource = { id: string; name: string; key: string }

async function optionalFile(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw new UsageFetchError('request-failed', 'Cannot read DSH credentials')
  }
}

async function nativeKey(home: string): Promise<string | undefined> {
  const raw = await optionalFile(path.join(home, '.credentials.yaml'))
  if (raw !== null) {
    const document = parseDocument(raw)
    // Parsing errors can contain the key's source line; never log them.
    if (document.errors.length || document.warnings.length) throw new UsageFetchError('request-failed', 'Invalid DSH credentials file')
    let value: unknown
    try { value = document.toJS({ maxAliasCount: 50 }) } catch { throw new UsageFetchError('request-failed', 'Invalid DSH credentials file') }
    const root = z.record(z.string(), z.unknown()).safeParse(value ?? {})
    const credentials = Credentials.safeParse(root.success && Object.keys(root.data).length === 0 ? { version: 1 } : value)
    if (!credentials.success) throw new UsageFetchError('request-failed', 'Invalid DSH credentials file')
    const managed = credentials.data.refs.DEEPSEEK_API_KEY?.trim()
    if (managed) return managed
  }
  const environment = process.env.DEEPSEEK_API_KEY?.trim()
  if (environment) return environment
  const dotenv = await optionalFile(path.join(home, '.env'))
  return dotenv === null ? undefined : parseEnv(dotenv).DEEPSEEK_API_KEY?.trim() || undefined
}

function officialProvider({ provider }: ResolvedModelProvider): boolean {
  return [provider.openai?.chatUrl, provider.openai?.responsesUrl, provider.anthropic?.baseUrl].some((address) => {
    if (!address) return false
    try {
      const url = new URL(address)
      return url.origin === 'https://api.deepseek.com' && !url.username && !url.password
    } catch { return false }
  })
}

export function parseDshBalance(body: unknown, source: Pick<BalanceSource, 'id' | 'name'>): UsageBalance[] {
  const parsed = BalanceResponse.safeParse(body)
  if (!parsed.success || new Set(parsed.data.balance_infos.map((balance) => balance.currency)).size !== parsed.data.balance_infos.length) {
    throw new UsageFetchError('request-failed', 'Invalid DeepSeek balance response')
  }
  return parsed.data.balance_infos.map((balance) => ({
    id: `${source.id}:${balance.currency}`, name: source.name, currency: balance.currency,
    total: balance.total_balance, granted: balance.granted_balance, toppedUp: balance.topped_up_balance,
    available: parsed.data.is_available
  }))
}

async function readBalance(source: BalanceSource): Promise<UsageBalance[]> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${source.key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000), redirect: 'error'
    })
  } catch { throw new UsageFetchError('request-failed', 'DeepSeek balance request failed') }
  if (response.status === 401 || response.status === 403) throw new UsageFetchError('api-key-rejected', 'DeepSeek API key was rejected')
  if (!response.ok) throw new UsageFetchError('request-failed', `DeepSeek balance endpoint answered ${response.status}`)
  let body: unknown
  try { body = await response.json() } catch { throw new UsageFetchError('request-failed', 'Invalid DeepSeek balance response') }
  return parseDshBalance(body, source)
}

export async function readDshUsage(home?: string, providers: readonly ResolvedModelProvider[] = []): Promise<UsageReading> {
  const sources: BalanceSource[] = providers.filter(officialProvider).map(({ provider, apiKey }) => ({ id: provider.id, name: provider.name, key: apiKey }))
  const key = await nativeKey(home ?? (process.env.DSH_HOME || path.join(homedir(), '.dsh')))
  if (key) sources.push({ id: 'dsh:deepseek', name: 'DeepSeek', key })
  // The same key can be configured in both Conclave and DSH.
  const unique = sources.filter((source, index) => sources.findIndex((other) => other.key === source.key) === index)
  if (!unique.length) return { signedIn: false }
  const fetched = await Promise.all(unique.map(async (source) => ({ source, balances: await readBalance(source) })))
  // Two different keys of one DeepSeek account report the same balance. The key saved in DSH
  // would otherwise repeat a provider row under the same name.
  const balances = fetched.filter((item) => item.source.id !== 'dsh:deepseek' || !fetched.some((other) => other.source.id !== 'dsh:deepseek' && sameBalance(other.balances, item.balances))).flatMap((item) => item.balances)
  return { signedIn: true, windows: [], plan: null, balances }
}

function sameBalance(left: readonly UsageBalance[], right: readonly UsageBalance[]): boolean {
  const signature = (list: readonly UsageBalance[]) => [...list]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((item) => `${item.currency}:${item.total}:${item.granted}:${item.toppedUp}:${item.available}`)
    .join('|')
  return signature(left) === signature(right)
}
