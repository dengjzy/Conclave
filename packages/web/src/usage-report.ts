import { useCallback, useEffect, useState } from 'react'
import { AGENT_KINDS, type AgentKind, type UsageFilter, type UsageHistory, type UsageTotals } from '@conclave/protocol'
import { perform, useCore } from './core-store'

export type UsageDrill = Pick<UsageFilter, 'agent' | 'account' | 'identity' | 'model' | 'source'>

export const usageTokens = (row: Pick<UsageTotals, 'input' | 'output'>) => row.input + row.output

// Input counts the cached tokens too, so what was neither read from nor written to the cache is the rest.
export function tokenParts(totals: UsageTotals) {
  return { cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, fresh: Math.max(0, totals.input - totals.cacheRead - totals.cacheWrite), output: totals.output }
}

export const cacheHit = (totals: UsageTotals) => totals.input > 0 ? totals.cacheRead / totals.input : null

const GRAPHS = 6

// An agent's colour, the same whatever the page is narrowed to: one of the six chart colours, by its place in the list.
export const agentGraph = (agent: AgentKind) => (AGENT_KINDS.indexOf(agent) % GRAPHS) + 1

export type AgentUsageShare = { agent: AgentKind; tokens: number; costUsd: number | null }

// Each agent's models added up, busiest first.
export function agentShares(models: UsageHistory['models']): AgentUsageShare[] {
  const byAgent = new Map<AgentKind, AgentUsageShare>()
  for (const row of models) {
    const entry = byAgent.get(row.agent) ?? { agent: row.agent, tokens: 0, costUsd: null }
    entry.tokens += usageTokens(row)
    if (row.costUsd !== null) entry.costUsd = (entry.costUsd ?? 0) + row.costUsd
    byAgent.set(row.agent, entry)
  }
  return [...byAgent.values()].sort((a, b) => b.tokens - a.tokens)
}

// The agents' usage of the range from their own logs, asked again whenever core finds more.
export function useUsageHistory(range: number, drill: UsageDrill) {
  const rpc = useCore((state) => state.rpc)
  const supported = rpc?.features.includes('usage-analytics') === true
  const [report, setReport] = useState<UsageHistory | null>(null)
  const [error, setError] = useState(false)
  const [scanning, setScanning] = useState(false)
  const load = useCallback(async () => {
    if (!rpc || !supported) return
    return rpc.call('usage.history', { range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...drill })
  }, [rpc, supported, range, drill])
  useEffect(() => {
    if (!rpc || !supported) return
    let current = true, sequence = 0
    const refresh = () => {
      const revision = ++sequence
      void load().then((result) => { if (current && revision === sequence && result) { setReport(result); setError(false) } }, () => { if (current) setError(true) })
    }
    setReport(null); refresh()
    const stop = rpc.on('usage.analyticsChanged', refresh)
    return () => { current = false; stop() }
  }, [rpc, supported, load])
  const scan = useCallback(async () => {
    if (!supported) return
    setScanning(true)
    try {
      await perform((client) => client.call('usage.scan', {}))
      const result = await load()
      if (result) setReport(result)
    } finally { setScanning(false) }
  }, [supported, load])
  return { supported, report, error, scanning: scanning || report?.scan.running === true, scan }
}
