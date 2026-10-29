import { useState } from 'react'
import { accountsSupported, type AgentKind, type UsageHistory } from '@conclave/protocol'
import { useCore } from '../core-store'
import { accountName } from '../agent-accounts'
import { getLocale, t } from '../i18n'
import { agentLabel } from '../labels'
import { dollars } from '../model-cost-format'
import { compact } from '../stat-format'
import { forecastText, useQuotaForecasts } from '../quota-forecast'
import { windowLabel } from '../usage-format'
import { agentGraph, usageTokens, type UsageDrill } from '../usage-report'
import { AgentIcon } from './icons'

const FIRST_MODELS = 8

// An agent without accounts has only the user's own; its identity snapshot is an opaque key, not a name.
export function useAccountName() {
  const accounts = useCore((state) => state.accounts)
  return (agent: AgentKind, id: string | null, identity?: string | null) => {
    if (!accountsSupported(agent)) return t('AgentAccounts.own')
    if (id === null) return t('UsageAnalytics.unknownAccount')
    const account = accounts?.accounts.find((entry) => entry.agent === agent && entry.id === id)
    return (identity?.includes('@') ? identity : null) || accountName(account ?? { id, label: null, email: null })
  }
}

function Share({ tokens, of, graph }: { tokens: number; of: number; graph: number }) {
  return (
    <span className="dashboard-share">
      {compact(tokens)}
      <span className="dashboard-share-track"><span data-graph={graph} style={{ width: `${of > 0 ? Math.max(2, (tokens / of) * 100) : 0}%` }} /></span>
    </span>
  )
}

// The busiest models first, the rest one click away; a row narrows the page to its model.
export function UsageModels({ report, drill, onDrill }: { report: UsageHistory; drill: UsageDrill; onDrill: (drill: UsageDrill) => void }) {
  const [all, setAll] = useState(false)
  const total = usageTokens(report.totals)
  const rows = all ? report.models : report.models.slice(0, FIRST_MODELS)
  const filtered = drill.agent !== undefined
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-usage-models">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-usage-models">{t('UsageAnalytics.models')}</h3>
        <span className="dashboard-panel-note">{t('UsageTables.byTokens')}</span>
      </header>
      {report.models.length === 0 ? <p className="dashboard-empty muted">{t('UsageAnalytics.empty')}</p> : (
        <table className="dashboard-models usage-table">
          <thead><tr><th scope="col">{t('AgentModelPicker.model')}</th><th scope="col">{t('UsageTables.requests')}</th><th scope="col">{t('UsageRings.cost')}</th><th scope="col">token</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.agent}/${row.model}`}>
                <th scope="row">
                  <button type="button" className="usage-table-pick" title={agentLabel(row.agent)} onClick={() => onDrill({ ...drill, agent: row.agent, model: row.model })}>
                    <AgentIcon agent={row.agent} />
                    {row.model ?? <span className="muted">{t('UsageAnalytics.unknownModel')}</span>}
                  </button>
                </th>
                <td>{row.requests.toLocaleString(getLocale())}</td>
                <td>{dollars(row.costUsd)}</td>
                <td><Share tokens={usageTokens(row)} of={total} graph={agentGraph(row.agent)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.models.length > FIRST_MODELS && (
        <button type="button" className="usage-table-more" onClick={() => setAll(!all)}>{all ? t('UsageTables.fewerModels') : t('UsageTables.allModels', { count: report.models.length })}</button>
      )}
      {filtered && <UsageSessions report={report} />}
      <UsageNotes report={report} />
    </section>
  )
}

function UsageSessions({ report }: { report: UsageHistory }) {
  return (
    <details className="usage-table-details">
      <summary>{t('UsageAnalytics.sessions')}</summary>
      {report.sessions.map((row, index) => (
        <div className="usage-session" key={`${row.agent}/${row.session}/${index}`}>
          <span title={row.cwd ?? row.session ?? ''}>{row.cwd || row.session || t('UsageAnalytics.background')}<small className="muted">{new Date(row.at).toLocaleString(getLocale())}</small></span>
          <span>{compact(usageTokens(row))} · {dollars(row.costUsd)}</span>
        </div>
      ))}
      <p className="dashboard-panel-note">{t('UsageAnalytics.sessionLimit')}</p>
    </details>
  )
}

// How far to trust the amounts, and how fresh the logs behind them are.
function UsageNotes({ report }: { report: UsageHistory }) {
  return (
    <div className="usage-table-notes">
      <p>{t('UsageAnalytics.costNote', { priced: report.totals.priced, total: report.totals.requests })} · {t('UsageAnalytics.reportedEstimated', { reported: dollars(report.totals.reportedUsd), estimated: dollars(report.totals.estimatedUsd) })}</p>
      {report.unallocated.requests > 0 && <p>{t('UsageAnalytics.unallocated', { count: report.unallocated.requests, tokens: compact(usageTokens(report.unallocated)) })}</p>}
      {report.scan.errors.length > 0 && <p role="status">{t('UsageAnalytics.partial')} · {report.scan.errors.join(' · ')}</p>}
      <p>{t('UsageAnalytics.scanNote', { files: report.scan.files, at: report.scan.updatedAt === null ? '—' : new Date(report.scan.updatedAt).toLocaleTimeString(getLocale()) })}</p>
    </div>
  )
}

// Whose quota the tokens came out of, and when each is expected to run out.
export function UsageAccounts({ report, drill, onDrill }: { report: UsageHistory; drill: UsageDrill; onDrill: (drill: UsageDrill) => void }) {
  const name = useAccountName()
  const forecasts = useQuotaForecasts().filter((entry) => drill.agent === undefined || entry.agent === drill.agent)
  const busiest = Math.max(0, ...report.accounts.map(usageTokens))
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-usage-accounts">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-usage-accounts">{t('UsageAnalytics.accounts')}</h3>
      </header>
      {report.accounts.length === 0 ? <p className="dashboard-empty muted">{t('UsageAnalytics.empty')}</p> : (
        <table className="dashboard-models usage-table">
          <thead><tr><th scope="col">{t('UsageAnalytics.account')}</th><th scope="col">token</th></tr></thead>
          <tbody>
            {report.accounts.map((row) => (
              <tr key={`${row.agent}/${row.account}/${row.identity}`}>
                <th scope="row">
                  <button type="button" className="usage-table-pick" title={agentLabel(row.agent)} onClick={() => onDrill({ ...drill, agent: row.agent, account: row.account, identity: row.identity })}>
                    <AgentIcon agent={row.agent} />
                    {name(row.agent, row.account, row.identity)}
                  </button>
                </th>
                <td><Share tokens={usageTokens(row)} of={busiest} graph={agentGraph(row.agent)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {forecasts.length > 0 && (
        <details className="usage-table-details">
          <summary>{t('UsageAnalytics.forecasts')}</summary>
          {forecasts.map((entry) => (
            <p key={`${entry.agent}/${entry.account}/${entry.window.kind}/${entry.window.model}`} className="usage-forecast">
              <span>{agentLabel(entry.agent)} · {name(entry.agent, entry.account)} · {windowLabel(entry.window)}</span>
              <span className="muted">{forecastText(entry)}</span>
            </p>
          ))}
        </details>
      )}
    </section>
  )
}
