import type { UsageHistory } from '@conclave/protocol'
import { t } from '../i18n'
import { dayLabel, labelledDay, shortDay } from '../dashboard-model'
import { dollars, tickDollars } from '../model-cost-format'
import { compact } from '../stat-format'
import { usageTokens } from '../usage-report'

const TICKS = [1, 0.75, 0.5, 0.25, 0]

// Each day's tokens beside what they cost, each on its own scale: tokens on the left, dollars on the right.
export function UsageDays({ days, range }: { days: UsageHistory['days']; range: number }) {
  const maxTokens = Math.max(1, ...days.map(usageTokens))
  const maxCost = Math.max(0.01, ...days.map((day) => day.costUsd ?? 0))
  // Past two weeks two bars a day no longer fit: the cost becomes a line over the token bars.
  const dense = days.length > 14
  return (
    <section className="dashboard-panel usage-days" aria-labelledby="dashboard-usage-days">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-usage-days">{t('UsageDays.title', { range })}</h3>
      </header>
      <div className="usage-days-chart">
        <div className="usage-days-axis" aria-hidden="true">{TICKS.map((tick) => <span key={tick}>{tick ? compact(maxTokens * tick) : 0}</span>)}</div>
        <div className="usage-days-plot" data-dense={dense || undefined} role="img" aria-label={t('UsageAnalytics.dailyTokens')}>
          {days.map((day, index) => (
            <div
              key={day.day}
              className="usage-days-day"
              data-tooltip={t('UsageDays.dayTooltip', { day: dayLabel(day.day), tokens: compact(usageTokens(day)), cost: dollars(day.costUsd) })}
              data-tooltip-side={index < days.length / 2 ? 'top' : 'top-end'}
            >
              <span data-graph="1" style={{ height: `${(usageTokens(day) / maxTokens) * 100}%` }} />
              {!dense && <span data-graph="2" style={{ height: `${((day.costUsd ?? 0) / maxCost) * 100}%` }} />}
            </div>
          ))}
          {dense && (
            <svg className="usage-days-line" data-graph="2" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <polyline points={days.map((day, index) => `${((index + 0.5) / days.length) * 100},${100 - ((day.costUsd ?? 0) / maxCost) * 100}`).join(' ')} />
            </svg>
          )}
        </div>
        <div className="usage-days-axis" aria-hidden="true">{TICKS.map((tick) => <span key={tick}>{tickDollars(maxCost * tick, maxCost)}</span>)}</div>
        <span />
        <div className="usage-days-labels" aria-hidden="true">{days.map((day, index) => <span key={day.day}>{labelledDay(index, days.length) ? shortDay(day.day) : ''}</span>)}</div>
      </div>
      <div className="dashboard-legend usage-days-legend">
        <span className="dashboard-swatch" data-graph="1" />token
        <span className="dashboard-swatch" data-graph="2" />{t('UsageDays.pricedCost')}
      </div>
    </section>
  )
}
