import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAccounts, ConversationStage } from '@conclave/protocol'
import { TaskStore } from './task-store'
import { UsageAnalytics } from './usage-analytics'
import { usageEvent } from './usage-events'

const now = Date.parse('2026-10-22T12:00:00Z')
const accounts: AgentAccounts = { accounts: [{ agent: 'codex', id: 'work', label: null, email: 'work@example.test', plan: null, signedIn: true, createdAt: 0 }], active: { codex: 'work' }, autoSwitch: true }
const stage: ConversationStage = { id: '00000000-0000-4000-8000-000000000001', conversationId: '00000000-0000-4000-8000-000000000002', agent: 'codex', providerSessionId: 'session', sessionId: null,
  receivedSequence: 0, startedAt: now - 2000, endedAt: null, exitCode: null, account: 'work' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function setup(stages: ConversationStage[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conclave-usage-ledger-')), file = path.join(root, 'conclave.db')
  const tasks = new TaskStore(file)
  const ledger = new UsageAnalytics(file, { roots: () => [{ agent: 'claude', home: root }], opencode: () => [], accounts: () => accounts,
    stages: () => stages, changed: () => {} }, () => now)
  cleanups.push(async () => { await ledger.close(); tasks.close(); await rm(root, { recursive: true, force: true }) })
  return { root, ledger }
}
const event = (id: string, at = now - 1000) => usageEvent('codex', id, at, { session: 'session', model: null, cwd: '/project', turn: 'turn' }, { input: 10, output: 2 })
const filter = { range: 7, timeZone: 'Asia/Shanghai' }

describe('usage ledger', () => {
  it('deduplicates shared and forked transcripts and attributes separate stages within the same session', async () => {
    const old = { ...stage, id: 'old-stage', account: 'personal', startedAt: now - 10_000, endedAt: now - 5000 }
    const { ledger } = await setup([old, stage])
    ledger.put('one', [event('old', now - 7000), event('new')])
    ledger.put('copy', [event('old', now - 7000), event('new')])
    expect(ledger.history(filter).totals).toMatchObject({ requests: 2, input: 20, output: 4, costUsd: null, priced: 0 })
    expect(ledger.history(filter).accounts.map((row) => row.account).sort()).toEqual(['personal', 'work'])
    expect(ledger.history({ ...filter, source: 'external' }).totals.requests).toBe(0)
  })
  it('does not change old external usage when the session is later imported or resumed', async () => {
    const { ledger } = await setup([stage])
    ledger.put('history', [event('outside', now - 20_000), event('inside')])
    expect(ledger.history({ ...filter, source: 'external' }).accounts).toMatchObject([{ account: null, input: 10 }])
    expect(ledger.history({ ...filter, source: 'conclave' }).accounts).toMatchObject([{ account: 'work', input: 10 }])
  })
  it('keeps the final streamed usage when an earlier fork copy sorts before the original', async () => {
    const { ledger } = await setup()
    ledger.put('a-copy', [{ ...event('request'), output: 1 }])
    ledger.put('z-original', [{ ...event('request'), output: 5 }])
    expect(ledger.history(filter).totals).toMatchObject({ requests: 1, output: 5 })
  })
  it('reconciles a live turn with its eventual native events without adding both', async () => {
    const { ledger } = await setup([stage])
    ledger.observe(stage, [{ kind: 'turn', id: 'turn:one', at: now, stageId: stage.id, revision: 1, state: 'completed', error: null, durationMs: 2000,
      providerRef: 'turn', metering: { models: [{ model: null, input: 20, output: 4, cacheRead: null, cacheWrite: null, cacheWrite1h: null, costUsd: null }], calls: 2, callsEstimated: false, reportedCostUsd: null } }])
    ledger.put('native', [event('one')])
    expect(ledger.history(filter).totals).toMatchObject({ input: 20, output: 4 })
    ledger.put('native', [event('two', now - 500)])
    expect(ledger.history(filter).totals).toMatchObject({ requests: 2, input: 20, output: 4 })
  })
  it('excludes session aggregates from time and model totals rather than assigning them to the last day', async () => {
    const { ledger } = await setup()
    ledger.put('session-db', [{ ...event('aggregate'), precision: 'session', input: 1000 }])
    expect(ledger.history(filter)).toMatchObject({ totals: { input: 0, requests: 0 }, unallocated: { input: 1000 }, models: [] })
  })
  it('keeps an unambiguous reported amount even when the model cannot be priced, but never prices a provider route', async () => {
    const { ledger } = await setup()
    const metering = { models: [{ model: null, input: 10, output: 2, cacheRead: null, cacheWrite: null, cacheWrite1h: null, costUsd: null }], reportedCostUsd: 0.2, calls: 1, callsEstimated: false }
    ledger.quick({ id: 'one', agent: 'codex', account: null, identity: null, startedAt: now, metering, unpriced: false })
    ledger.quick({ id: 'two', agent: 'codex', account: null, identity: null, startedAt: now, metering, unpriced: true })
    expect(ledger.history(filter).totals).toMatchObject({ requests: 2, priced: 1, reportedUsd: 0.2, costUsd: 0.2, input: 20 })
  })
  it('runs the packaged-worker entry contract against an isolated transcript home', async () => {
    const { root, ledger } = await setup()
    await mkdir(path.join(root, 'projects'), { recursive: true })
    await writeFile(path.join(root, 'projects', 'test.jsonl'), `${JSON.stringify({ type: 'assistant', sessionId: 'outside', timestamp: new Date(now).toISOString(),
      message: { id: 'msg', model: 'claude-sonnet-5-5', usage: { input_tokens: 7, output_tokens: 3 } } })}\n`)
    await ledger.scan()
    expect(ledger.status().errors).toEqual([])
    expect(ledger.history(filter).totals).toMatchObject({ input: 7, output: 3 })
    await ledger.scan()
    expect(ledger.history(filter).totals.requests).toBe(1)
  })
})
