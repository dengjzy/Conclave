import { t, tr } from '../i18n'
import { coverage, dollars, headlineDollars } from '../model-cost-format'
import type { DashboardDay, DashboardStats, UsageHistory } from '@conclave/protocol'
import { acceptance, change, dayTokens, rateChange, type Change } from '../dashboard-model'
import { compact, durationText, finePercent, percent } from '../stat-format'
import { cacheHit, usageTokens } from '../usage-report'

type Kpi = { label: string; title: string; value: string; note?: string; change?: Change | null; trend?: number[] }

// The range's shape at a glance; drawn in a quiet grey, since it only repeats the number above it.
function Sparkline({ values }: { values: readonly number[] }) {
  const max = Math.max(...values)
  if (values.length < 2 || max === 0) return <span className="dashboard-spark" />
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 64},${22 - (value / max) * 20}`).join(' ')
  return (
    <svg className="dashboard-spark" viewBox="0 0 64 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

const ARROW = { up: '↑', down: '↓', flat: '' } as const

function KpiCard({ kpi, range }: { kpi: Kpi; range: number }) {
  return (
    <div className="dashboard-kpi" title={kpi.title}>
      <span className="dashboard-kpi-label">{kpi.label}</span>
      <span className="dashboard-kpi-value">{kpi.value}</span>
      <span className="dashboard-kpi-foot">
        {kpi.change ? (
          <span className="dashboard-kpi-change" data-direction={kpi.change.direction}>
            {ARROW[kpi.change.direction]}{kpi.change.text}
            <span className="dashboard-kpi-since">{tr('DashboardKpis.comparedWithPreviousDays', { range: range })}</span>
          </span>
        ) : (
          <span className="dashboard-kpi-since">{kpi.note ?? t('DashboardKpis.noDataForThePreviousDays', { range: range })}</span>
        )}
      </span>
      {kpi.trend ? <Sparkline values={kpi.trend} /> : <span className="dashboard-spark" />}
    </div>
  )
}

// The headline numbers of the range: what the agents spent from their own logs, then Conclave's own work
// against the range before it.
export function DashboardKpis({ stats, days, range, usage }: { stats: DashboardStats; days: readonly DashboardDay[]; range: number; usage: UsageHistory | null }) {
  const { current, previous } = stats
  const rate = acceptance(current.accepted, current.decided)
  const hit = usage ? cacheHit(usage.totals) : null
  const spend: Kpi[] = usage ? [
    { label: t('DashboardKpis.totalTokens'), title: t('DashboardKpis.tokensTheAgentsReadAndWrote'), value: compact(usageTokens(usage.totals)), note: t('UsageRings.requests', { count: usage.totals.requests }), trend: usage.days.map(usageTokens) },
    {
      label: t('UsageRings.cost'), title: t('UsageAnalytics.costNote', { priced: usage.totals.priced, total: usage.totals.requests }), value: headlineDollars(usage.totals.costUsd),
      note: usage.totals.requests > 0 ? t('DashboardKpis.pricedRequests', { share: finePercent(usage.totals.priced / usage.totals.requests) }) : undefined, trend: usage.days.map((day) => day.costUsd ?? 0)
    },
    { label: t('DashboardKpis.cacheHit'), title: t('DashboardKpis.shareOfInputReadFromTheCache'), value: hit === null ? '—' : finePercent(hit), note: t('DashboardKpis.cacheRead', { tokens: compact(usage.totals.cacheRead) }) }
  ] : [
    { label: t('DashboardKpis.totalTokens'), title: t('DashboardKpis.tokensReadAndWrittenByTaskRunsConversation'), value: compact(current.tokens), change: change(current.tokens, previous.tokens), trend: days.map(dayTokens) }
  ]
  const medianRun: Kpi = {
    label: t('DashboardKpis.medianDuration'),
    title: t('DashboardKpis.fromRunStartToDeliveryIncludingYourResponse'),
    value: durationText(current.medianRunMs),
    change: current.medianRunMs === null || previous.medianRunMs === null ? null : change(current.medianRunMs, previous.medianRunMs)
  }
  const small = stats.smallModels?.current
  const fourth: Kpi[] = small ? [{
    label: t('DashboardKpis.smallModelSavings'), title: t('DashboardKpis.estimatedAtApiListPricesModelPriceDifference', { value1: coverage(small) }),
    value: small.savedUsd === null ? '—' : t('DashboardKpis.about', { value1: dollars(small.savedUsd) }),
    note: t('DashboardKpis.estimableRequests', { value1: small.estimated, value2: small.count })
  }] : [medianRun]
  const kpis: Kpi[] = [
    ...spend,
    ...fourth,
    { label: t('DashboardKpis.conversationTurns'), title: t('DashboardKpis.completedConversationTurnsExcludingTaskChats'), value: String(current.turns), change: change(current.turns, previous.turns), trend: days.map((day) => day.turns) },
    { label: t('DashboardKpis.taskRuns'), title: t('DashboardKpis.agentRunsThatEndedInThisPeriod'), value: String(current.runs), change: change(current.runs, previous.runs), trend: days.map((day) => day.runs) },
    {
      label: t('DashboardKpis.acceptanceRate'),
      title: t('DashboardKpis.shareOfReviewedRunsAcceptedDirectly'),
      value: rate === null ? '—' : percent(current.accepted, current.decided),
      note: rate === null ? t('DashboardKpis.onlyReviewsTooFewSamples', { value1: current.decided }) : undefined,
      change: rateChange(rate, acceptance(previous.accepted, previous.decided))
    },
    {
      label: t('DashboardKpis.failedInterrupted'),
      title: t('DashboardKpis.turnsEndingWithErrorsIncludingQuotaLimitsStopped'),
      value: `${current.failedTurns} / ${current.interruptedTurns}`,
      note: current.turns > 0 ? t('DashboardKpis.ofTurns', { value1: percent(current.failedTurns + current.interruptedTurns, current.turns) }) : t('DashboardKpis.noTurns')
    },
    ...(usage ? [] : small ? [medianRun] : [])
  ]
  return (
    <div className="dashboard-kpis">
      {kpis.map((kpi) => <KpiCard key={kpi.label} kpi={kpi} range={range} />)}
    </div>
  )
}
