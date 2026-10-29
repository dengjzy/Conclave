import { localized, t, tr } from '../i18n'
import { useState } from 'react'
import type { DashboardDay } from '@conclave/protocol'
import { dayLabel, labelledDay } from '../dashboard-model'
import { compact } from '../stat-format'
import { Segmented } from './SettingsControls'

type Metric = 'tokens' | 'count'
const METRICS = localized(() => ([
  { value: 'tokens', label: 'token' },
  { value: 'count', label: t('DailyBars.count') }
] as const))

const parts = (day: DashboardDay, metric: Metric) =>
  metric === 'tokens' ? { runs: day.runTokens, turns: day.turnTokens, quick: day.quickTokens ?? 0 } : { runs: day.runs, turns: day.turns, quick: day.quickRequests ?? 0 }

// Each day of the range as one bar, task runs stacked under conversation turns.
export function DailyBars({ days }: { days: readonly DashboardDay[] }) {
  const [metric, setMetric] = useState<Metric>('tokens')
  const max = Math.max(1, ...days.map((day) => parts(day, metric).runs + parts(day, metric).turns + parts(day, metric).quick))
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-daily">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-daily">{t('DailyBars.dailyTrends')}</h3>
        <span className="dashboard-legend">{tr('DailyBars.tasksconversationsquickRequests', { value1: <span className="dashboard-swatch" data-series="runs" />, value2: <span className="dashboard-swatch" data-series="turns" />, value3: <span className="dashboard-swatch" data-series="quick" /> })}</span>
        <Segmented labelId="dashboard-daily" value={metric} options={METRICS} onChange={setMetric} />
      </header>
      <div className="dashboard-bars-frame">
        <span className="dashboard-bars-max">{compact(max)}</span>
        <div className="dashboard-bars" data-dense={days.length > 45 || undefined}>
          {days.map((day, index) => {
            const { runs, turns, quick } = parts(day, metric)
            return (
              <div
                key={day.day}
                className="dashboard-bar"
                data-tooltip={t('DailyBars.tasksConversationsQuickRequests', { value1: dayLabel(day.day), value2: compact(runs), value3: compact(turns), value4: compact(quick) })}
                data-tooltip-side={index < days.length / 2 ? 'top' : 'top-end'}
              >
                <div className="dashboard-bar-stack">
                  <span data-series="quick" style={{ height: `${(quick / max) * 100}%` }} />
                  <span data-series="turns" style={{ height: `${(turns / max) * 100}%` }} />
                  <span data-series="runs" style={{ height: `${(runs / max) * 100}%` }} />
                </div>
                <span className="dashboard-bar-label">{labelledDay(index, days.length) ? dayLabel(day.day) : ''}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
