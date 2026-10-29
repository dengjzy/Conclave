import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentDescriptor, modelPrice, type ChatItem, type CostBaseline, type ModelMetering } from '@conclave/protocol'
import { TaskStore } from './task-store'
import { SmallModelStore, EMPTY_BASELINE, estimateSmallModel, smallModelTotals } from './small-model-store'
import { summarizeDashboard } from './dashboard-stats'
import { QuickRequests } from './quick-request'
import { TranslationService } from './translation-service'
import { Rejection } from './rejection'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { ProjectRegistry } from './project-registry'
import { AttachmentStore } from './attachment-store'
import { fakeChatDaemon } from './fake-chat-agent'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const prices = [...agentDescriptor('claude').prices ?? []]
const baseline: CostBaseline = { model: 'claude-opus-5-5', context: 600_000, price: modelPrice(prices, 'claude-opus-5-5', NOW) }
const metering: ModelMetering = {
  models: [{ model: 'claude-haiku-4-5', input: 50_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: null }],
  calls: 4, callsEstimated: false, reportedCostUsd: 0.05
}
const job = { kind: 'helper' as const, baseline, prices, metering, state: 'completed' as const, startedAt: NOW }

describe('small-model estimates', () => {
  it('adds model difference and avoided context, subtracting actual cost only once', () => {
    expect(estimateSmallModel(job)).toMatchObject({ costUsd: 0.05, modelDifferenceUsd: expect.closeTo(0.15), contextSavedUsd: 0.48, savedUsd: 0.63 })
    expect(estimateSmallModel({ ...job, kind: 'translation' })).toMatchObject({ savedUsd: expect.closeTo(0.15), contextSavedUsd: 0 })
    expect(estimateSmallModel({ ...job, baseline: { ...baseline, context: null } })).toMatchObject({ savedUsd: expect.closeTo(0.15), contextSavedUsd: null })
  })

  it('clamps the combined result, not each component, and excludes failure savings', () => {
    expect(estimateSmallModel({ ...job, metering: { ...metering, reportedCostUsd: 0.5 } })).toMatchObject({ savedUsd: expect.closeTo(0.18) })
    expect(estimateSmallModel({ ...job, metering: { ...metering, reportedCostUsd: 1 } })).toMatchObject({ savedUsd: 0 })
    expect(estimateSmallModel({ ...job, state: 'failed' })).toMatchObject({ costUsd: 0.05, savedUsd: null })
  })

  it('does not fabricate prices or savings when either model is unresolved', () => {
    expect(estimateSmallModel({ ...job, baseline: EMPTY_BASELINE })).toMatchObject({ costUsd: 0.05, savedUsd: null })
    expect(estimateSmallModel({ ...job, metering: { ...metering, models: metering.models.map((model) => ({ ...model, model: 'haiku' })) } })).toMatchObject({ costUsd: null, savedUsd: null })
    expect(estimateSmallModel({ ...job, metering: null })).toMatchObject({ costUsd: null, savedUsd: null })
    expect(estimateSmallModel({ ...job, metering: { ...metering, calls: null } })).toMatchObject({ calls: 1, callsEstimated: true, contextSavedUsd: 0.12 })
  })
})

describe('small-model accounting', () => {
  let root: string
  let database: string
  let tasks: TaskStore
  let store: SmallModelStore

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-small-models-'))
    database = path.join(root, 'conclave.db')
    tasks = new TaskStore(database)
    store = new SmallModelStore(database, () => NOW)
  })
  afterEach(() => { store.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })

  const begin = (kind: 'helper' | 'translation' | 'commitMessage' = 'helper', id?: string) => store.begin({ kind, id, agent: 'claude', model: 'haiku', conversationId: 'conversation', baseline })
  const turn = (fields: Partial<Extract<ChatItem, { kind: 'turn' }>> = {}): Extract<ChatItem, { kind: 'turn' }> => ({
    id: 'turn:request', stageId: 'stage', revision: 1, at: NOW, kind: 'turn', state: 'completed', error: null, durationMs: 1000, usage: { input: 50_000, output: 0 }, metering, ...fields
  })

  it('deduplicates replay, captures prices and baselines, and survives deleted ownership and reopening', () => {
    const snapshot = structuredClone(baseline)
    store.begin({ kind: 'helper', id: 'stage/turn:request', agent: 'claude', model: 'haiku', conversationId: 'deleted-parent', baseline: snapshot })
    snapshot.context = 10
    store.observe([turn()])
    store.observe([turn()])
    store.interruptConversation('deleted-parent')
    expect(store.decorate([turn()])[0]).toMatchObject({ smallModelCost: { savedUsd: 0.63, baseline: { context: 600_000 } } })
    store.close()
    store = new SmallModelStore(database, () => NOW)
    expect(smallModelTotals(store.endedSince(0))).toMatchObject({ count: 1, priced: 1, estimated: 1, savedUsd: 0.63 })
  })

  it('counts unavailable usage without turning it into zero cost', () => {
    store.finish(begin(), 'completed')
    store.finish(begin('translation'), 'failed', metering)
    expect(smallModelTotals(store.endedSince(0))).toMatchObject({ count: 2, measured: 1, priced: 1, estimated: 0, costUsd: 0.05, savedUsd: null })
  })

  it('shares immutable price versions and reads compact statistics with unchanged totals', () => {
    const repeated = { ...metering, models: [...metering.models, ...metering.models] }
    store.finish(begin('translation'), 'completed', repeated)
    store.finish(begin('commitMessage'), 'completed')
    const zero = { ...metering, reportedCostUsd: 0, models: metering.models.map((model) => ({ ...model, input: 0 })) }
    store.finish(begin('translation'), 'completed', zero)
    const db = new DatabaseSync(database)
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM small_model_price_versions').get()?.count).toBe(1)
      const rows = db.prepare('SELECT data, stats_data FROM small_model_jobs').all()
      for (const row of rows) expect(JSON.parse(String(row.data))).not.toHaveProperty('prices')
      expect(JSON.parse(String(rows[0]?.data)).cost.prices).toHaveLength(1)
      expect(String(rows[0]?.stats_data).length).toBeLessThan(String(rows[0]?.data).length / 2)
    } finally { db.close() }
    const full = store.endedSince(0)
    const compact = store.statsSince(0)
    expect(compact[0]?.metering?.models).toEqual([{ model: 'claude-haiku-4-5', input: 100_000, output: 0 }])
    const options = { range: 7, timeZone: 'Asia/Shanghai', now: NOW }
    expect(summarizeDashboard([], [], options, compact)).toEqual(summarizeDashboard([], [], options, full))
    expect(smallModelTotals(compact)).toEqual(smallModelTotals(full))
    expect(smallModelTotals(compact)).toMatchObject({ measured: 2, priced: 2, estimated: 2 })
  })

  it('migrates legacy snapshots in batches without repricing, and resumes pending jobs with their original prices', () => {
    store.close()
    const db = new DatabaseSync(database)
    const legacyPrices = prices.map((price) => price.model === 'claude-haiku-4-5' ? { ...price, rates: { ...price.rates, input: 7 } } : price)
    const originalCost = { ...estimateSmallModel(job), costUsd: 123, savedUsd: 456 }
    const original = { ...job, id: '', agent: 'claude', model: 'haiku', conversationId: null, endedAt: NOW,
      totalTokens: 50_000, cost: { ...originalCost, prices: [...originalCost.prices, ...originalCost.prices] } }
    try {
      const insert = db.prepare('INSERT INTO small_model_jobs (id, ended_at, data) VALUES (?, ?, ?)')
      for (let index = 0; index < 101; index++) insert.run(`legacy-${index}`, NOW, JSON.stringify({ ...original, id: `legacy-${index}` }))
      insert.run('pending', null, JSON.stringify({ ...original, id: 'pending', endedAt: null, state: 'running',
        prices: legacyPrices, metering: null, totalTokens: null, cost: null }))
    } finally { db.close() }
    store = new SmallModelStore(database, () => NOW)
    expect(smallModelTotals(store.statsSince(0))).toMatchObject({ count: 101, costUsd: 123 * 101, savedUsd: 456 * 101 })
    expect(store.endedSince(0)[0]?.cost?.prices).toHaveLength(1)
    store.close()
    store = new SmallModelStore(database, () => NOW)
    store.finish('pending', 'completed', { ...metering, reportedCostUsd: null })
    expect(store.endedSince(0).find((entry) => entry.id === 'pending')?.cost?.costUsd).toBeCloseTo(0.35)
    const migrated = new DatabaseSync(database)
    try {
      expect(migrated.prepare('SELECT COUNT(*) AS count FROM small_model_jobs WHERE price_version IS NULL').get()?.count).toBe(0)
      expect(migrated.prepare('SELECT COUNT(*) AS count FROM small_model_price_versions').get()?.count).toBe(2)
    } finally { migrated.close() }
  })

  it('recovers only started helper jobs and leaves old logged turns out of the new ledger', async () => {
    begin('helper', 'stage/turn:request')
    await store.recoverHelpers({ stages: () => [{ conversationId: 'conversation', stageId: 'stage', ended: true }], items: () => [turn(), turn({ id: 'turn:old' })] })
    expect(store.endedSince(0)).toHaveLength(1)
    const quick = begin('translation')
    store.recoverQuick()
    expect(store.endedSince(0).find((entry) => entry.id === quick)).toMatchObject({ state: 'interrupted', cost: { costUsd: null, savedUsd: null } })
  })

  it('adds quick tokens to daily totals and model breakdown without counting helper tokens twice', () => {
    store.finish(begin(), 'completed', metering)
    store.finish(begin('translation'), 'completed', metering)
    store.finish(begin('commitMessage'), 'completed', metering, null, NOW - 7 * 86_400_000)
    const report = summarizeDashboard([], [{ conversationId: 'helper', agent: 'claude', model: 'haiku', state: 'completed', durationMs: 1000, totalTokens: 50_000, usageLimit: 0, endedAt: NOW }], { range: 7, timeZone: 'Asia/Shanghai', now: NOW }, store.statsSince(0))
    expect(report.current).toMatchObject({ tokens: 100_000, turns: 1 })
    expect(report.previous).toMatchObject({ tokens: 50_000, turns: 0 })
    expect(report.days.at(-1)).toMatchObject({ turnTokens: 50_000, quickTokens: 50_000, quickRequests: 1 })
    expect(report.models.reduce((sum, model) => sum + model.tokens, 0)).toBe(100_000)
    expect(report.smallModels).toMatchObject({ current: { count: 2 }, previous: { count: 1 } })
  })

  it('records translation execution once per cache miss, excluding untracked branch naming', async () => {
    const quick = new QuickRequests({
      accounting: store, catalog: async () => null,
      run: async () => JSON.stringify({ result: '译文', model: 'claude-haiku-4-5', num_turns: 1, total_cost_usd: 0.05,
        usage: { input_tokens: 50_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    })
    const service = new TranslationService(quick)
    const tracking = { kind: 'translation' as const, conversationId: 'parent', baseline: () => baseline }
    await Promise.all([service.translate('claude', 'hi', 'en', undefined, tracking), service.translate('claude', 'hi', 'en', undefined, tracking)])
    await quick.ask('claude', 'branch name')
    expect(store.endedSince(0)).toHaveLength(1)
  })

  it('accounts for title generation while keeping the new category out of older clients', async () => {
    const quick = new QuickRequests({ accounting: store, catalog: async () => ({ models: [
      { id: 'haiku', label: 'Haiku', description: null, efforts: [], isDefault: false }
    ] }), run: async () => JSON.stringify({ result: '缓存优化', model: 'claude-haiku-4-5', num_turns: 1, total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) })
    await quick.ask('claude', 'summarize a title', undefined, { kind: 'title', conversationId: 'parent', baseline: () => baseline })
    const jobs = store.statsSince(0)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: 'title', totalTokens: 110, cost: { costUsd: 0.05 } })
    const options = { range: 7, timeZone: 'Asia/Shanghai', now: NOW }
    const legacy = summarizeDashboard([], [], options, jobs)
    expect(legacy.smallModels?.kinds.map((entry) => entry.kind)).not.toContain('title')
    expect(legacy.smallModels?.current.count).toBe(0)
    const report = summarizeDashboard([], [], { ...options, includeTitleCosts: true }, jobs)
    expect(report.smallModels?.kinds.find((entry) => entry.kind === 'title')).toMatchObject({ count: 1, tokens: 110 })
    expect(report.current.tokens).toBe(110)
  })

  it('sends a job on a model provider straight to it, on its small model, and keeps it unpriced', async () => {
    const asked: Array<{ url: string; body: Record<string, unknown> }> = []
    const quick = new QuickRequests({
      accounting: store, catalog: async () => null,
      run: async () => { throw new Error('the agent CLI is not used') },
      fetch: async (url, init) => {
        asked.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '标题' }], usage: { input_tokens: 120, output_tokens: 8 } }), { status: 200 })
      }
    })
    const provider = { endpoint: { wire: 'anthropic' as const, baseUrl: 'https://gw.example.com', anthropic: { baseUrl: 'https://gw.example.com', auth: 'auth_token' as const, env: {} } }, apiKey: 'k', model: 'gw-small', routeKey: 'gw|anthropic|https://gw.example.com' }
    const tracking = { kind: 'translation' as const, conversationId: 'parent', baseline: () => baseline }
    expect(await quick.ask('claude', 'name it', 'haiku', tracking, provider)).toEqual({ text: '标题', model: 'gw-small' })
    expect(asked).toMatchObject([{ url: 'https://gw.example.com/v1/messages', body: { model: 'gw-small' } }])
    const [kept] = store.endedSince(0)
    expect(kept).toMatchObject({ model: 'gw-small', totalTokens: 128, prices: [], baseline: EMPTY_BASELINE, cost: { costUsd: null, savedUsd: null } })
    // A reply is translated on the provider once.
    const translations = new TranslationService(quick)
    await translations.translate('claude', 'hi', 'en', undefined, tracking, provider)
    await translations.translate('claude', 'hi', 'en', undefined, tracking, provider)
    expect(asked).toHaveLength(2)
  })

  it('keeps reported usage from a failed command and records a retry as a new execution', async () => {
    let failure = true
    const quick = new QuickRequests({ accounting: store, catalog: async () => null, run: async () => ({
      stdout: JSON.stringify({ result: 'answer', model: 'claude-haiku-4-5', num_turns: 1, total_cost_usd: 0.05,
        usage: { input_tokens: 50_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
      error: failure ? new Rejection('quick-failed') : null
    }) })
    const tracking = { kind: 'commitMessage' as const, conversationId: 'parent', baseline: () => baseline }
    await expect(quick.ask('claude', 'commit', undefined, tracking)).rejects.toMatchObject({ reason: 'quick-failed' })
    failure = false
    await quick.ask('claude', 'commit', undefined, tracking)
    expect(smallModelTotals(store.endedSince(0))).toMatchObject({ count: 2, priced: 2, estimated: 1, costUsd: 0.1 })
  })

  it('captures the parent at actual dispatch and retains the helper cost after clearing its conversation', async () => {
    const conversationsStore = new ConversationStore(database)
    const projects = new ProjectRegistry(database)
    const daemon = fakeChatDaemon()
    const attachments = path.join(root, 'attachments')
    mkdirSync(attachments)
    const conversations = new ConversationService(conversationsStore, daemon, path.join(root, 'sessions'), (event) => {
      if (event.type === 'prompt') {
        const helper = conversations.get(event.conversationId)
        if (helper.helperOf) store.begin({ kind: 'helper', id: `${event.stageId}/turn:${event.ref}`, agent: helper.agent, model: 'haiku', conversationId: helper.id, baseline: conversations.costBaseline(helper.helperOf) })
      } else if (event.type === 'chatItems') store.observe(event.items)
    }, projects, new AttachmentStore(attachments))
    daemon.deliver = (event) => {
      if (event.event === 'data') conversations.handleData(event)
      else if (event.event === 'exit') conversations.handleExit(event.sessionId, event.exitCode)
    }
    daemon.reply = (sessionId) => {
      daemon.emit(sessionId, { type: 'assistant', parent_tool_use_id: null, message: { id: sessionId, model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } })
      daemon.emit(sessionId, { type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } })
    }
    try {
      const parent = await conversations.create('claude', [])
      await conversations.send(parent.id, 'main')
      await new Promise((resolve) => setTimeout(resolve, 0))
      const helper = await conversations.create('claude', [], false, { helperOf: parent.id, deferStart: true })
      await conversations.continue(helper.id)
      await conversations.send(helper.id, 'small')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(store.endedSince(0)).toHaveLength(1)
      expect(store.endedSince(0)[0]).toMatchObject({ kind: 'helper', baseline: { context: 1100, model: 'claude-sonnet-5' }, cost: { costUsd: expect.any(Number), savedUsd: expect.any(Number) } })
      await conversations.delete(helper.id)
      expect(store.endedSince(0)).toHaveLength(1)
    } finally {
      for (const conversation of conversations.listAll()) await conversations.delete(conversation.id)
      projects.close(); conversationsStore.close()
    }
  })
})
