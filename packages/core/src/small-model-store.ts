import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  AgentKind, CostBaseline, ModelMetering, ModelPrice, SmallModelCost, SmallModelKind,
  agentDescriptor, meteringTokens, modelPrice, ratesAt, tokenCost,
  type ChatItem, type SmallModelTotals
} from '@conclave/protocol'

const Job = z.object({
  id: z.string(), kind: SmallModelKind, conversationId: z.string().nullable(), agent: AgentKind,
  model: z.string().nullable(), startedAt: z.number(), endedAt: z.number().nullable(),
  state: z.enum(['running', 'completed', 'failed', 'interrupted']), baseline: CostBaseline,
  prices: z.array(ModelPrice).default([]), metering: ModelMetering.nullable(),
  totalTokens: z.number().nonnegative().nullable(), cost: SmallModelCost.nullable()
})
export type SmallModelJob = z.infer<typeof Job>
const Summary = Job.pick({ kind: true, agent: true, model: true, endedAt: true, totalTokens: true }).extend({
  cost: z.object({ costUsd: z.number().nullable(), savedUsd: z.number().nullable() }).nullable(),
  metering: z.object({ models: z.array(z.object({ model: z.string().nullable(), input: z.number(), output: z.number() })) }).nullable()
})
export type SmallModelSummary = z.infer<typeof Summary>
export const EMPTY_BASELINE: CostBaseline = { model: null, context: null, price: null }

function uniquePrices(prices: readonly ModelPrice[]): ModelPrice[] {
  return [...new Map(prices.map((price) => [JSON.stringify(price), price])).values()]
}

function jobData(job: SmallModelJob): string {
  const { prices: _prices, ...data } = job
  return JSON.stringify(data)
}

function summaryData(job: SmallModelJob): string {
  const models = new Map<string | null, { model: string | null; input: number; output: number }>()
  for (const usage of job.metering?.models ?? []) {
    const model = models.get(usage.model) ?? { model: usage.model, input: 0, output: 0 }
    model.input += usage.input
    model.output += usage.output
    models.set(usage.model, model)
  }
  return JSON.stringify({
    kind: job.kind, agent: job.agent, model: job.model, endedAt: job.endedAt, totalTokens: job.totalTokens,
    cost: job.cost ? { costUsd: job.cost.costUsd, savedUsd: job.cost.savedUsd } : null,
    metering: job.metering ? { models: [...models.values()] } : null
  })
}

export function estimateSmallModel(job: Pick<SmallModelJob, 'kind' | 'baseline' | 'prices' | 'metering' | 'state' | 'startedAt'>): SmallModelCost {
  const usage = job.metering
  const priced = usage?.models.map((model) => ({ model, price: modelPrice(job.prices, model.model, job.startedAt) })) ?? []
  const known = priced.length > 0 && priced.every((entry) => entry.price !== null)
  const actual = priced.map(({ model, price }) => price ? model.costUsd ?? tokenCost(model, price) : null)
  const costUsd = known ? usage?.reportedCostUsd ?? sumKnown(actual) : null
  const main = job.baseline.price
  const baselineCosts = known && main ? priced.map(({ model }) => tokenCost(model, main, job.baseline.context ?? 0)) : []
  const baselineCost = baselineCosts.length ? sumKnown(baselineCosts) : null
  const difference = baselineCost !== null && costUsd !== null ? baselineCost - costUsd : null
  const calls = usage ? usage.calls ?? 1 : null
  const context = job.baseline.context
  const contextSaved = job.kind === 'translation' ? 0 : main && context !== null && calls !== null
    ? context * calls * ratesAt(main, context).cacheRead / 1_000_000 : null
  const completed = job.state === 'completed'
  return {
    costUsd, savedUsd: completed && difference !== null ? Math.max(0, difference + (contextSaved ?? 0)) : null,
    modelDifferenceUsd: difference, contextSavedUsd: contextSaved, baseline: job.baseline,
    calls, callsEstimated: usage?.callsEstimated === true || usage?.calls == null,
    prices: uniquePrices(priced.flatMap(({ price }) => price ? [price] : [])), completed
  }
}

function sumKnown(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

// No foreign keys: clearing a helper or deleting its parent does not erase what it spent.
export class SmallModelStore {
  private readonly db: DatabaseSync
  private readonly priceVersions = new Map<string, ModelPrice[]>()

  constructor(file: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrateSnapshots()
  }

  close(): void { this.db.close() }

  // unpriced: a job on a model provider's plan, which neither the agent's prices nor the chat's
  // model as a baseline say anything of; its tokens are kept, never a cost or a saving.
  begin({ unpriced = false, ...fields }: { kind: SmallModelKind; agent: AgentKind; model: string | null; conversationId: string | null; baseline: CostBaseline; id?: string; unpriced?: boolean }): string {
    const id = fields.id ?? randomUUID()
    const job: SmallModelJob = {
      ...fields, id, startedAt: this.now(), endedAt: null, state: 'running',
      ...(unpriced ? { baseline: EMPTY_BASELINE } : {}),
      prices: unpriced ? [] : [...agentDescriptor(fields.agent).prices ?? []], metering: null, totalTokens: null, cost: null
    }
    this.db.exec('BEGIN')
    try {
      const version = this.savePrices(job.prices)
      this.db.prepare('INSERT OR IGNORE INTO small_model_jobs (id, conversation_id, data, price_version) VALUES (?, ?, ?, ?)').run(id, fields.conversationId, jobData(job), version)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return id
  }

  finish(id: string, state: 'completed' | 'failed' | 'interrupted', metering?: ModelMetering, totalTokens: number | null = null, endedAt = this.now()): void {
    const job = this.get(id)
    if (!job || job.endedAt !== null) return
    job.state = state
    job.endedAt = endedAt
    job.metering = metering ?? null
    job.totalTokens = metering ? meteringTokens(metering) : totalTokens
    job.model = metering?.models[0]?.model ?? job.model
    job.cost = estimateSmallModel(job)
    this.db.prepare('UPDATE small_model_jobs SET ended_at = ?, data = ?, stats_data = ? WHERE id = ? AND ended_at IS NULL').run(endedAt, jobData(job), summaryData(job), id)
  }

  observe(items: readonly ChatItem[]): void {
    for (const item of items) {
      if (item.kind !== 'turn') continue
      const total = item.usage ? 'total' in item.usage ? item.usage.total : item.usage.input + item.usage.output : null
      this.finish(`${item.stageId}/${item.id}`, item.state, item.metering, total, item.at)
    }
  }

  decorate(items: readonly ChatItem[]): ChatItem[] {
    return items.map((item) => {
      if (item.kind !== 'turn') return item
      const cost = this.get(`${item.stageId}/${item.id}`)?.cost
      return cost ? { ...item, smallModelCost: cost } : item
    })
  }

  endedSince(since: number): SmallModelJob[] {
    return this.db.prepare('SELECT data,price_version FROM small_model_jobs WHERE ended_at >= ?').all(since).map((row) => ({
      ...Job.parse(JSON.parse(String(row.data))), prices: row.price_version === null ? [] : this.loadPrices(String(row.price_version))
    }))
  }

  statsSince(since: number): SmallModelSummary[] {
    return this.db.prepare('SELECT stats_data FROM small_model_jobs WHERE ended_at >= ?').all(since).map((row) => Summary.parse(JSON.parse(String(row.stats_data))))
  }

  // Completed quick jobs cannot be recovered after core exits; helper turns recover from their logs.
  recoverQuick(): void {
    const jobs = this.db.prepare('SELECT data FROM small_model_jobs WHERE ended_at IS NULL').all().map((row) => Job.parse(JSON.parse(String(row.data))))
    for (const job of jobs) if (job.kind !== 'helper') this.finish(job.id, 'interrupted')
  }

  async recoverHelpers(source: { stages(): Array<{ conversationId: string; stageId: string; ended: boolean }>; items(conversationId: string, stageId: string): ChatItem[] }): Promise<void> {
    const pending = this.db.prepare('SELECT data FROM small_model_jobs WHERE ended_at IS NULL').all().map((row) => Job.parse(JSON.parse(String(row.data))))
    const stages = new Map(source.stages().map((stage) => [stage.stageId, stage]))
    for (const job of pending) {
      if (job.kind !== 'helper') continue
      const stage = stages.get(job.id.split('/')[0] ?? '')
      if (stage) this.observe(source.items(stage.conversationId, stage.stageId))
      if (!stage || stage.ended) this.finish(job.id, 'interrupted')
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  interruptConversation(conversationId: string): void {
    const pending = this.db.prepare('SELECT id FROM small_model_jobs WHERE conversation_id = ? AND ended_at IS NULL').all(conversationId)
    for (const row of pending) this.finish(String(row.id), 'interrupted')
  }

  private get(id: string): SmallModelJob | null {
    const row = this.db.prepare('SELECT data, price_version FROM small_model_jobs WHERE id = ?').get(id)
    if (!row) return null
    const job = Job.parse(JSON.parse(String(row.data)))
    if (job.endedAt === null) job.prices = this.loadPrices(String(row.price_version))
    return job
  }

  private savePrices(prices: readonly ModelPrice[]): string {
    const data = JSON.stringify(prices)
    const id = createHash('sha256').update(data).digest('hex')
    this.db.prepare('INSERT OR IGNORE INTO small_model_price_versions (id, data) VALUES (?, ?)').run(id, data)
    return id
  }

  private loadPrices(id: string): ModelPrice[] {
    const cached = this.priceVersions.get(id)
    if (cached) return cached
    const row = this.db.prepare('SELECT data FROM small_model_price_versions WHERE id = ?').get(id)
    if (!row) throw new Error(`Missing small-model price version: ${id}`)
    const prices = z.array(ModelPrice).parse(JSON.parse(String(row.data)))
    this.priceVersions.set(id, prices)
    return prices
  }

  // Batches make interrupted upgrades resumable; historical amounts are never recalculated.
  private migrateSnapshots(): void {
    const pending = this.db.prepare('SELECT id, data FROM small_model_jobs WHERE price_version IS NULL LIMIT 100')
    const update = this.db.prepare('UPDATE small_model_jobs SET data = ?, price_version = ?, stats_data = ? WHERE id = ?')
    while (true) {
      this.db.exec('BEGIN')
      try {
        const rows = pending.all()
        for (const row of rows) {
          const job = Job.parse(JSON.parse(String(row.data)))
          const version = this.savePrices(job.prices)
          if (job.cost) job.cost.prices = uniquePrices(job.cost.prices)
          update.run(jobData(job), version, job.endedAt === null ? null : summaryData(job), String(row.id))
        }
        this.db.exec('COMMIT')
        if (rows.length < 100) break
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }
}

export function smallModelTotals(jobs: readonly Pick<SmallModelSummary, 'cost' | 'totalTokens'>[]): SmallModelTotals {
  const priced = jobs.filter((job) => job.cost?.costUsd != null)
  const estimated = jobs.filter((job) => job.cost?.savedUsd != null)
  return {
    count: jobs.length, tokens: jobs.reduce((sum, job) => sum + (job.totalTokens ?? 0), 0), measured: jobs.filter((job) => job.totalTokens !== null).length, priced: priced.length, estimated: estimated.length,
    costUsd: priced.length ? priced.reduce((sum, job) => sum + (job.cost?.costUsd ?? 0), 0) : null,
    savedUsd: estimated.length ? estimated.reduce((sum, job) => sum + (job.cost?.savedUsd ?? 0), 0) : null
  }
}
