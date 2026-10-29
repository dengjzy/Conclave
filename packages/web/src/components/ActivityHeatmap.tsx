import { localized, t, tr } from '../i18n'
import type { DashboardDay } from '@conclave/protocol'
import { activity, dayLabel, heatLevels, monthLabels, streaks, weeks } from '../dashboard-model'

const WEEKDAYS = localized(() => ([t('ActivityHeatmap.mon'), '', t('ActivityHeatmap.wed'), '', t('ActivityHeatmap.fri'), '', t('ActivityHeatmap.sun')]))

// The past year a day per square, Monday on top, darker for busier days.
export function ActivityHeatmap({ days }: { days: readonly DashboardDay[] }) {
  const heat = heatLevels(days.map(activity))
  const levels = new Map(days.map((day, index) => [day.day, heat[index] ?? 0]))
  const columns = weeks(days)
  const months = monthLabels(columns)
  const { active, longest } = streaks(days)
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-activity">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-activity">{t('ActivityHeatmap.activity')}</h3>
        <span className="dashboard-panel-note">{tr('ActivityHeatmap.activeOnDaysOverThePastYearLongest', { active: active, longest: longest })}</span>
      </header>
      <div className="dashboard-heatmap-scroll">
        <div className="dashboard-heatmap-body">
          <div className="dashboard-heatmap" style={{ gridTemplateColumns: `auto repeat(${columns.length}, var(--heat-cell))` }}>
            <span />
            {months.map((month, index) => <span key={index} className="dashboard-heatmap-month">{month}</span>)}
            <div className="dashboard-heatmap-weekdays">
              {WEEKDAYS.map((name, index) => <span key={index}>{name}</span>)}
            </div>
            {columns.map((column, index) => (
              <div key={index} className="dashboard-heatmap-week">
                {column.map((day, row) =>
                  day ? (
                    <span
                      key={day.day}
                      className="dashboard-heat"
                      data-level={levels.get(day.day)}
                      data-tooltip={t('ActivityHeatmap.taskRunsConversationTurnsQuickRequests', { value1: dayLabel(day.day), value2: day.runs, value3: day.turns, value4: day.quickRequests ?? 0 })}
                      data-tooltip-side={index < columns.length / 2 ? 'top' : 'top-end'}
                    />
                  ) : (
                    <span key={`pad-${row}`} />
                  )
                )}
              </div>
            ))}
          </div>
          <div className="dashboard-heat-legend" aria-hidden="true">{tr('ActivityHeatmap.lessmore', { value1: [0, 1, 2, 3, 4].map((level) => <span key={level} className="dashboard-heat" data-level={level} />) })}</div>
        </div>
      </div>
    </section>
  )
}
