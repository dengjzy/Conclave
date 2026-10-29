import { t, tr } from '../i18n'
import type { SmallModelStats as Stats } from '@conclave/protocol'
import { coverage, dollars, SMALL_MODEL_LABELS } from '../model-cost-format'
import { compact } from '../stat-format'

export function SmallModelStats({ stats }: { stats: Stats }) {
  return <section className="dashboard-panel" aria-labelledby="dashboard-small-models">
    <header className="dashboard-panel-header">
      <h3 id="dashboard-small-models">{t('SmallModelStats.smallModelUsage')}</h3>
      <span className="dashboard-panel-note">{t('SmallModelStats.estimatedAtApiListPrices')}</span>
    </header>
    <p className="dashboard-panel-note">{tr('SmallModelStats.savingsAreCalculatedPerRequestAndFlooredAt', { value1: coverage(stats.current) })}</p>
    <table className="dashboard-models">
      <thead><tr><th scope="col">{t('SmallModelStats.purpose')}</th><th scope="col">{t('DailyBars.count')}</th><th scope="col">token</th><th scope="col">{t('SmallModelStats.cost')}</th><th scope="col">{t('SmallModelStats.estimatedSavings')}</th></tr></thead>
      <tbody>{stats.kinds.map((row) => <tr key={row.kind} title={coverage(row)}>
        <th scope="row">{SMALL_MODEL_LABELS[row.kind]}</th><td>{row.count}</td><td>{row.measured ? compact(row.tokens) : row.count ? t('SmallModelStats.unavailable') : '—'}</td><td>{dollars(row.costUsd)}</td><td>{dollars(row.savedUsd)}</td>
      </tr>)}</tbody>
    </table>
    <p className="dashboard-panel-note">{t('SmallModelStats.translationCountsOnlyTheModelPriceDifferenceCommit')}</p>
  </section>
}
