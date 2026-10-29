import type { AgentKind, UsageTotals } from '@conclave/protocol'
import { t } from '../i18n'
import { agentLabel } from '../labels'
import { headlineDollars, dollars } from '../model-cost-format'
import { compact } from '../stat-format'
import { agentGraph, tokenParts, usageTokens, type AgentUsageShare } from '../usage-report'
import { DashboardRing } from './DashboardRing'

// What the tokens of the range were: mostly cache reads, for an agent that resends its context each turn.
export function TokenMix({ totals }: { totals: UsageTotals }) {
  const { cacheRead, cacheWrite, fresh, output } = tokenParts(totals)
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-token-mix">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-token-mix">{t('UsageRings.tokenMix')}</h3>
        <span className="dashboard-panel-note">{t('UsageRings.requests', { count: totals.requests })}</span>
      </header>
      <DashboardRing
        total={compact(usageTokens(totals))}
        caption={t('UsageRings.total')}
        parts={[
          { key: 'cacheRead', label: t('UsageRings.cacheRead'), value: cacheRead, detail: compact(cacheRead), graph: 1 },
          { key: 'cacheWrite', label: t('UsageRings.cacheWrite'), value: cacheWrite, detail: compact(cacheWrite), graph: 4 },
          { key: 'fresh', label: t('UsageRings.uncachedInput'), value: fresh, detail: compact(fresh), graph: 3 },
          { key: 'output', label: t('UsageRings.output'), value: output, detail: t('UsageRings.outputDetail', { tokens: compact(output) }), graph: 2 }
        ]}
      />
    </section>
  )
}

// Each agent's share of the range; picking one narrows the page to it.
export function AgentUsage({ agents, totals, onPick }: { agents: readonly AgentUsageShare[]; totals: UsageTotals; onPick: (agent: AgentKind) => void }) {
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-agent-usage">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-agent-usage">{t('UsageRings.byAgent')}</h3>
        {agents.length > 1 && <span className="dashboard-panel-note">{t('UsageRings.pickToNarrow')}</span>}
      </header>
      <DashboardRing
        total={headlineDollars(totals.costUsd)}
        caption={t('UsageRings.cost')}
        parts={agents.map((row) => ({ key: row.agent, label: agentLabel(row.agent), value: row.tokens, detail: `${compact(row.tokens)} · ${dollars(row.costUsd)}`, graph: agentGraph(row.agent) }))}
        onPick={(key) => { const row = agents.find((entry) => entry.agent === key); if (row) onPick(row.agent) }}
      />
    </section>
  )
}
