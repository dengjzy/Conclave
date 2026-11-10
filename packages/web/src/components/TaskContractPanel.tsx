import { useEffect, useState } from 'react'
import { TaskContractFields, type Task, type TaskContract } from '@conclave/protocol'
import { perform, useCore } from '../core-store'
import { t } from '../i18n'
import { projectName } from './ProjectPicker'

type Draft = Omit<TaskContract, 'updatedAt'>

function withoutTime(contract: TaskContract): Draft {
  const { updatedAt: _updatedAt, ...draft } = contract
  return draft
}

// The task's acceptance contract: what "done" means before an agent starts. The Flow panel shows
// what a run did with it; this is where it is written.
export function TaskContractPanel({ task }: { task: Task }) {
  const rpc = useCore((state) => state.rpc)
  const supported = useCore((state) => state.rpc?.features.includes('task-contracts') ?? false)
  const [saved, setSaved] = useState<TaskContract | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!rpc || !supported) return
    let live = true
    void rpc.call('tasks.contract', { id: task.id })
      .then((found) => { if (live) { setSaved(found); setDraft(found ? withoutTime(found) : null) } })
      .catch(() => {})
    return () => { live = false }
  }, [rpc, supported, task.id, task.updatedAt])

  if (!supported) return null

  const save = async (fields: Draft) => {
    setBusy(true)
    try {
      const next = await perform((connection) => connection.call('tasks.setContract', { id: task.id, contract: fields }))
      if (next) { setSaved(next); setDraft(withoutTime(next)) }
    } finally {
      setBusy(false)
    }
  }

  const create = () => void save(TaskContractFields.parse({ goal: task.details }))

  if (!draft) {
    return (
      <section className="contract-panel">
        <header className="contract-heading"><strong>{t('ContractPanel.title')}</strong></header>
        <p className="muted">{t('ContractPanel.empty')}</p>
        <button type="button" className="button" disabled={busy} onClick={create}>{t('ContractPanel.create')}</button>
      </section>
    )
  }

  const verification = draft.verification
  const patch = (next: Partial<Draft>) => setDraft((current) => current ? { ...current, ...next } : current)
  const patchVerification = (next: Partial<Draft['verification']>) => setDraft((current) => current ? { ...current, verification: { ...current.verification, ...next } } : current)
  const checks = verification.checks
  const setChecks = (next: Draft['verification']['checks']) => patchVerification({ checks: next })

  return (
    <section className="contract-panel">
      <header className="contract-heading">
        <strong>{t('ContractPanel.title')}</strong>
        <span className="muted">{t('ContractPanel.baseline', { value1: verification.baseline.length })}</span>
      </header>
      <label className="contract-field">
        <span>{t('ContractPanel.goal')}</span>
        <textarea className="input" rows={3} value={draft.goal} onChange={(event) => patch({ goal: event.target.value })} />
      </label>
      <div className="contract-grid">
        <label className="contract-field">
          <span>{t('ContractPanel.risk')}</span>
          <select className="input" value={draft.risk} onChange={(event) => patch({ risk: event.target.value as Draft['risk'] })}>
            <option value="low">{t('ContractPanel.risk.low')}</option>
            <option value="medium">{t('ContractPanel.risk.medium')}</option>
            <option value="high">{t('ContractPanel.risk.high')}</option>
          </select>
        </label>
        <label className="contract-field">
          <span>{t('ContractPanel.autonomy')}</span>
          <select className="input" value={draft.autonomy} onChange={(event) => patch({ autonomy: event.target.value as Draft['autonomy'] })}>
            <option value="auto">{t('ContractPanel.autonomy.auto')}</option>
            <option value="confirm">{t('ContractPanel.autonomy.confirm')}</option>
            <option value="human-only">{t('ContractPanel.autonomy.human')}</option>
          </select>
        </label>
      </div>
      <div className="contract-checks">
        <span>{t('ContractPanel.checks')}</span>
        {checks.map((check, index) => (
          <div className="contract-check" key={`${check.repo}-${index}`}>
            <select className="input" value={check.repo} onChange={(event) => setChecks(checks.map((each, at) => at === index ? { ...each, repo: event.target.value } : each))}>
              {task.repos.map((repo) => <option key={repo.path} value={repo.path}>{projectName(repo.path)}</option>)}
            </select>
            <input className="input" value={check.command} placeholder={t('ContractPanel.command')} onChange={(event) => setChecks(checks.map((each, at) => at === index ? { ...each, command: event.target.value } : each))} />
            <button type="button" className="button ghost" aria-label={t('ContractPanel.removeCheck')} onClick={() => setChecks(checks.filter((_, at) => at !== index))}>×</button>
          </div>
        ))}
        <button type="button" className="button ghost" onClick={() => setChecks([...checks, { repo: task.repos[0]?.path ?? '', command: '', timeoutMs: 600_000, required: true }])}>{t('ContractPanel.addCheck')}</button>
      </div>
      <p className="muted">{t('ContractPanel.criteria', { value1: verification.criteria.length, value2: verification.human.length, value3: verification.unknowns.length })}</p>
      <div className="contract-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void save({ ...draft, verification: { ...verification, checks: checks.filter((check) => check.repo && check.command.trim()) } })}>{t('ContractPanel.save')}</button>
        {saved && <span className="muted">{t('ContractPanel.saved')}</span>}
      </div>
    </section>
  )
}
