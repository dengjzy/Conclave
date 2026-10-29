import { getLocale, localized, t, tr } from '../i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { TASK_STATUSES, type DashboardStats } from '@conclave/protocol'
import { perform, useCore } from '../core-store'
import { DASHBOARD_RANGES, type DashboardRange } from '../dashboard-model'
import { STATUS_LABEL } from '../labels'
import { percent } from '../stat-format'
import { ActivityHeatmap } from './ActivityHeatmap'
import { DailyBars } from './DailyBars'
import { DashboardKpis } from './DashboardKpis'
import { SmallModelStats } from './SmallModelStats'
import { UsageDays } from './UsageDays'
import { AgentUsage, TokenMix } from './UsageRings'
import { UsageAccounts, UsageModels, useAccountName } from './UsageTables'
import { agentLabel } from '../labels'
import { agentShares, useUsageHistory, type UsageDrill } from '../usage-report'
import { RefreshIcon } from './icons'
import { ModelBreakdown } from './ModelBreakdown'
import { Segmented } from './SettingsControls'
import { StatusIcon } from './StatusIcon'

const SOURCE_OPTIONS = localized(() => [
  { value: 'all', label: t('UsageAnalytics.all') }, { value: 'conclave', label: 'Conclave' }, { value: 'external', label: t('UsageAnalytics.external') }
] as const)
const RANGE_OPTIONS = localized(() => DASHBOARD_RANGES.map((range) => ({ value: String(range), label: t('DashboardPanel.days', { range }) })))
const reportTime = (at: number) => new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(at)

// Asked for on opening, on a new range and on refresh: the numbers move only as runs and turns end.
function useDashboard(range: DashboardRange) {
  const connected = useCore((s) => s.connection === 'connected')
  const [report, setReport] = useState<{ stats: DashboardStats; at: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const stats = await perform((rpc) => rpc.call('dashboard.stats', { range, timeZone, ...(rpc.features.includes('small-model-stats') ? { includeSmallModels: true, includeTitleCosts: true } : {}) }))
    setLoading(false)
    if (stats) setReport({ stats, at: Date.now() })
  }, [range])
  useEffect(() => {
    if (connected) void load()
  }, [connected, load])
  return { report, loading, load }
}

// What the tasks are now: the range does not apply, a task has no history of its statuses.
function TaskStatuses() {
  const tasks = useCore((s) => s.tasks)
  const all = Object.values(tasks)
  const counts = TASK_STATUSES.map((status) => ({ status, count: all.filter((task) => task.status === status).length }))
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-statuses">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-statuses">{t('DashboardPanel.taskStatus')}</h3>
        <span className="dashboard-panel-note">{tr('DashboardPanel.totalNow', { value1: all.length })}</span>
      </header>
      {all.length === 0 ? (
        <p className="dashboard-empty muted">{t('DashboardPanel.noTasksYet')}</p>
      ) : (
        <>
          <div className="dashboard-status-bar" aria-hidden="true">
            {counts.map(({ status, count }) => count > 0 && <span key={status} data-status={status} style={{ flexGrow: count }} />)}
          </div>
          <ul className="dashboard-status-list">
            {counts.map(({ status, count }) => (
              <li key={status}>
                <StatusIcon status={status} decorative />
                <span>{STATUS_LABEL[status]}</span>
                <span className="dashboard-status-count">{count}</span>
                <span className="dashboard-status-share muted">{percent(count, all.length)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

// What the page is narrowed to: an agent, then a model or an account of it.
function DrillChip({ drill, onClear }: { drill: UsageDrill; onClear: () => void }) {
  const name = useAccountName()
  if (drill.agent === undefined) return null
  const parts = [agentLabel(drill.agent), ...(drill.account !== undefined ? [name(drill.agent, drill.account, drill.identity)] : []), ...(drill.model !== undefined ? [drill.model ?? t('UsageAnalytics.unknownModel')] : [])]
  return (
    <span className="dashboard-drill">
      {parts.join(' · ')}
      <button type="button" className="button ghost" onClick={onClear}>{t('UsageAnalytics.clearFilters')}</button>
    </span>
  )
}

// The overview's 统计: the days before, as its 现在 is the work at hand.
export function DashboardPanel() {
  const [range, setRange] = useState<DashboardRange>(7)
  const [drill, setDrill] = useState<UsageDrill>({})
  const { report, loading, load } = useDashboard(range)
  const usage = useUsageHistory(range, drill)
  const days = report?.stats.days.slice(-range) ?? []
  const empty = report !== null && report.stats.days.every((day) => day.runs === 0 && day.turns === 0 && (day.quickRequests ?? 0) === 0)
  const spent = usage.report
  const agents = useMemo(() => agentShares(spent?.models ?? []), [spent])
  const refresh = () => { void load(); void usage.scan() }
  return (
    <div className="dashboard-stats">
      <div className="dashboard-toolbar">
        <p className="muted">{tr('DashboardPanel.taskRunsConversationsAndQuickRequestsGroupedBy', { value1: report && t('DashboardPanel.updated', { value1: reportTime(report.at) }) })}</p>
        <DrillChip drill={drill} onClear={() => setDrill({ source: drill.source })} />
        {usage.supported && (
          <>
            <Segmented
              labelId="dashboard-source"
              value={drill.source ?? 'all'}
              options={SOURCE_OPTIONS}
              onChange={(value) => setDrill({ ...drill, source: value === 'all' ? undefined : value })}
            />
            <span id="dashboard-source" hidden>{t('UsageAnalytics.source')}</span>
          </>
        )}
        <Segmented
          labelId="dashboard-range"
          value={String(range)}
          options={RANGE_OPTIONS}
          onChange={(value) => setRange(DASHBOARD_RANGES.find((option) => String(option) === value) ?? 7)}
        />
        <span id="dashboard-range" hidden>{t('DashboardPanel.timeRange')}</span>
        <button type="button" className="tool-button" aria-label={t('DashboardPanel.scanAndRefresh')} data-tooltip={t('DashboardPanel.scanAndRefresh')} disabled={loading || usage.scanning} onClick={refresh}>
          <span className="dashboard-refresh" data-loading={loading || usage.scanning || undefined}><RefreshIcon /></span>
        </button>
      </div>
      {report === null ? (
        <p className="dashboard-empty muted">{t('DashboardPanel.loading')}</p>
      ) : (
        <div className="dashboard-grid">
          {empty && !spent?.totals.requests && (
            <p className="dashboard-empty dashboard-empty-all muted">{t('DashboardPanel.noRunHistoryYetCompletedTaskRunsConversation')}</p>
          )}
          {usage.error && !spent && <p className="dashboard-empty muted">{t('UsageAnalytics.failed')}</p>}
          <div className="dashboard-row dashboard-row-wide">
            <DashboardKpis stats={report.stats} days={days} range={range} usage={spent} />
            {spent && <UsageDays days={spent.days} range={range} />}
          </div>
          {spent && (
            <div className="dashboard-row">
              <TokenMix totals={spent.totals} />
              <AgentUsage agents={agents} totals={spent.totals} onPick={(agent) => setDrill({ source: drill.source, agent })} />
            </div>
          )}
          <div className="dashboard-row dashboard-row-wide">
            <DailyBars days={days} />
            <TaskStatuses />
          </div>
          {spent && (
            <div className="dashboard-row dashboard-row-wide">
              <UsageModels report={spent} drill={drill} onDrill={setDrill} />
              <UsageAccounts report={spent} drill={drill} onDrill={setDrill} />
            </div>
          )}
          <ModelBreakdown models={report.stats.models} />
          {report.stats.smallModels && <SmallModelStats stats={report.stats.smallModels} />}
          <ActivityHeatmap days={report.stats.days} />
        </div>
      )}
    </div>
  )
}
