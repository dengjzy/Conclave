import { useEffect, useRef, useState } from 'react'
import { appendDraft } from '../composer-drafts'
import { t } from '../i18n'
import { pullReference, readPull, type PullData } from '../pull-request'

export function PullRequestPanel({ conversationId, initialUrl = '' }: { conversationId: string; initialUrl?: string }) {
  const [url, setUrl] = useState(() => {
    try { return localStorage.getItem(`conclave.pull-url:${conversationId}`) ?? initialUrl } catch { return initialUrl }
  })
  const [data, setData] = useState<PullData | null>(null)
  const [problem, setProblem] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState({ pull: true, checks: true, reviews: true })
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort(); pending.current = null }, [])
  const reference = pullReference(url)
  const stale = problem || reference?.url !== data?.reference.url
  async function load() {
    if (!reference) return
    try { localStorage.setItem(`conclave.pull-url:${conversationId}`, reference.url) } catch { /* URL stays in memory. */ }
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setProblem(false)
    try {
      const result = await readPull(reference, controller.signal)
      if (pending.current === controller) setData(result)
    } catch {
      if (pending.current === controller && !controller.signal.aborted) setProblem(true)
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false) }
    }
  }
  function insert() {
    if (!data) return
    const facts: Record<string, unknown> = { url: data.reference.url, fetchedAt: new Date(data.fetchedAt).toISOString(), stale }
    if (selected.pull) facts.pull = data.pull
    if (selected.checks) {
      const statuses = data.status?.statuses.toSorted((a, b) => Number(a.state === 'success') - Number(b.state === 'success'))
      const checks = data.checks?.check_runs.toSorted((a, b) => Number(a.conclusion === 'success') - Number(b.conclusion === 'success'))
      facts.status = data.status && { state: data.status.state, total: data.status.total_count, shown: statuses?.slice(0, 30).map((item) => ({ ...item, context: item.context.slice(0, 150) })) }
      facts.checkRuns = data.checks && { total: data.checks.total_count, shown: checks?.slice(0, 30).map((item) => ({ ...item, name: item.name.slice(0, 150) })) }
    }
    if (selected.reviews) facts.reviews = data.reviews && { fetchedCount: data.reviews.length, shown: data.reviews.slice(-30) }
    appendDraft(conversationId, `${t('PullRequestPanel.untrusted')}\n${JSON.stringify(facts, null, 2)}`)
  }
  return <div className="pull-request-panel">
    <p className="muted">{t('PullRequestPanel.help')}</p>
    <label htmlFor={`pull-url-${conversationId}`}>{t('PullRequestPanel.url')}</label>
    <div className="pull-request-input">
      <input id={`pull-url-${conversationId}`} className="input" type="url" value={url} placeholder="https://github.com/owner/repo/pull/123" onChange={(event) => setUrl(event.target.value)} />
      <button type="button" className="button" disabled={!reference || loading} onClick={() => void load()}>{loading ? t('PullRequestPanel.loading') : t('PullRequestPanel.load')}</button>
    </div>
    {url && !reference && <p role="status">{t('PullRequestPanel.invalid')}</p>}
    {reference && <a href={reference.url} target="_blank" rel="noreferrer">{t('PullRequestPanel.open')}</a>}
    {problem && <p role="status">{t('PullRequestPanel.failed')}</p>}
    {!data && !problem && <p className="muted">{t('PullRequestPanel.disconnected')}</p>}
    {data && <section aria-label="Pull request">
      <p className="muted">{t(stale ? 'PullRequestPanel.stale' : 'PullRequestPanel.fetched', { time: new Date(data.fetchedAt).toLocaleString() })}</p>
      <a href={data.reference.url} target="_blank" rel="noreferrer">{data.reference.url}</a>
      <label className="pull-request-choice"><input type="checkbox" checked={selected.pull} onChange={(event) => setSelected({ ...selected, pull: event.target.checked })} /> {t('PullRequestPanel.summary')}</label>
      <p><strong>{data.pull.title}</strong><br />{data.pull.merged ? 'merged' : data.pull.draft ? 'draft' : data.pull.state}<br /><span className="mono">{data.pull.head.sha}</span></p>
      <label className="pull-request-choice"><input type="checkbox" checked={selected.checks} onChange={(event) => setSelected({ ...selected, checks: event.target.checked })} /> CI</label>
      <p>{data.status ? `Status: ${data.status.state} (${data.status.statuses.length}/${data.status.total_count})` : t('PullRequestPanel.unavailable')}<br />{data.checks ? t('PullRequestPanel.checkCount', { shown: data.checks.check_runs.length, total: data.checks.total_count }) : t('PullRequestPanel.unavailable')}</p>
      {data.checks && <ul>{data.checks.check_runs.map((check, i) => <li key={i}>{check.name}: {check.conclusion ?? check.status}</li>)}</ul>}
      {data.status && <ul>{data.status.statuses.map((status, i) => <li key={i}>{status.context}: {status.state}</li>)}</ul>}
      <label className="pull-request-choice"><input type="checkbox" checked={selected.reviews} onChange={(event) => setSelected({ ...selected, reviews: event.target.checked })} /> {t('PullRequestPanel.reviews')}</label>
      {data.reviews ? <><p className="muted">{t('PullRequestPanel.first100')}</p><ul>{data.reviews.map((review, i) => <li key={i}>{review.user?.login ?? '—'}: {review.state}</li>)}</ul></> : <p>{t('PullRequestPanel.unavailable')}</p>}
      <button type="button" className="button" disabled={!selected.pull && !selected.checks && !selected.reviews} onClick={insert}>{t('PullRequestPanel.insert')}</button>
    </section>}
  </div>
}
