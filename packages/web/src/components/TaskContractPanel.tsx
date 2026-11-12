import { useEffect, useState } from 'react'
import { RatchetDirection, TaskContractFields, type Task, type TaskContract } from '@conclave/protocol'
import { perform, useCore } from '../core-store'
import { t } from '../i18n'
import { projectName } from './ProjectPicker'

type Draft = Omit<TaskContract, 'updatedAt'>

const RISKS = ['low', 'medium', 'high'] as const
const AUTONOMY_MODES = ['auto', 'confirm', 'human-only'] as const

function withoutTime(contract: TaskContract): Draft {
  const { updatedAt: _updatedAt, ...draft } = contract
  return draft
}

// The task's acceptance contract: machine-executable checks, optional metric ratchet, and human
// review items. Context and implementation notes live in the task specification above.
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

  const create = async () => {
    const defaultChecks: Draft['verification']['checks'] = []
    if (rpc?.features.includes('project-config')) {
      for (const repo of task.repos) {
        if (repo.reference) continue
        const info = await rpc.call('projects.config', { path: repo.path }).catch(() => null)
        if (info?.config?.check) {
          defaultChecks.push({ repo: repo.path, command: info.config.check, timeoutMs: 600_000, required: true })
        }
      }
    }
    void save(TaskContractFields.parse({
      goal: '',
      verification: { checks: defaultChecks }
    }))
  }

  if (!draft) {
    return (
      <section className="contract-panel">
        <header className="contract-heading"><strong>{t('ContractPanel.title')}</strong></header>
        <p className="muted">{t('ContractPanel.empty')}</p>
        <div className="contract-actions">
          <button type="button" className="button" disabled={busy} onClick={() => void create()}>{t('ContractPanel.create')}</button>
        </div>
      </section>
    )
  }

  const verification = draft.verification
  const ratchet = verification.ratchet ?? null
  const checks = verification.checks
  const human = verification.human
  const patch = (next: Partial<Draft>) => setDraft((current) => current ? { ...current, ...next } : current)
  const patchVerification = (next: Partial<Draft['verification']>) => setDraft((current) => current ? { ...current, verification: { ...current.verification, ...next } } : current)
  const setChecks = (next: Draft['verification']['checks']) => patchVerification({ checks: next })
  const setHuman = (next: Draft['verification']['human']) => patchVerification({ human: next })

  return (
    <section className="contract-panel">
      <header className="contract-heading">
        <strong>{t('ContractPanel.title')}</strong>
        {verification.baseline.length > 0 && <span className="muted">{t('ContractPanel.baseline', { value1: verification.baseline.length })}</span>}
      </header>
      <label className="contract-field">
        <span>{t('ContractPanel.goal')}</span>
        <input
          className="input"
          value={draft.goal}
          placeholder={t('ContractPanel.goalPlaceholder')}
          onChange={(event) => patch({ goal: event.target.value })}
        />
      </label>
      <div className="contract-grid">
        <label className="contract-field">
          <span>{t('ContractPanel.risk')}</span>
          <select
            className="input"
            value={draft.risk}
            onChange={(event) => {
              const found = RISKS.find((each) => each === event.target.value)
              if (found) patch({ risk: found })
            }}
          >
            <option value="low">{t('ContractPanel.risk.low')}</option>
            <option value="medium">{t('ContractPanel.risk.medium')}</option>
            <option value="high">{t('ContractPanel.risk.high')}</option>
          </select>
        </label>
        <label className="contract-field">
          <span>{t('ContractPanel.autonomy')}</span>
          <select
            className="input"
            value={draft.autonomy}
            onChange={(event) => {
              const found = AUTONOMY_MODES.find((each) => each === event.target.value)
              if (found) {
                patch({ autonomy: found })
                patchVerification({ autonomy: found })
              }
            }}
          >
            <option value="auto">{t('ContractPanel.autonomy.auto')}</option>
            <option value="confirm">{t('ContractPanel.autonomy.confirm')}</option>
            <option value="human-only">{t('ContractPanel.autonomy.human')}</option>
          </select>
        </label>
        <label className="contract-field">
          <span>{t('ContractPanel.maxAttempts')}</span>
          <input
            type="number"
            min={1}
            max={20}
            className="input"
            value={draft.constraints.maxAttempts}
            onChange={(event) => {
              const count = Math.min(20, Math.max(1, Number.parseInt(event.target.value, 10) || 1))
              patch({ constraints: { ...draft.constraints, maxAttempts: count } })
            }}
          />
        </label>
      </div>
      <div className="contract-checks">
        <span>{t('ContractPanel.checks')}</span>
        {checks.map((check, index) => (
          <div className="contract-check" key={`${check.repo}-${index}`}>
            <select
              className="input"
              value={check.repo}
              onChange={(event) => setChecks(checks.map((each, at) => at === index ? { ...each, repo: event.target.value } : each))}
            >
              {task.repos.length === 0 && <option value="">—</option>}
              {task.repos.map((repo) => <option key={repo.path} value={repo.path}>{projectName(repo.path)}</option>)}
            </select>
            <input
              className="input"
              value={check.command}
              placeholder={t('ContractPanel.command')}
              onChange={(event) => setChecks(checks.map((each, at) => at === index ? { ...each, command: event.target.value } : each))}
            />
            <button type="button" className="button ghost" aria-label={t('ContractPanel.removeCheck')} onClick={() => setChecks(checks.filter((_, at) => at !== index))}>×</button>
          </div>
        ))}
        <button
          type="button"
          className="button ghost"
          disabled={task.repos.length === 0}
          onClick={() => setChecks([...checks, { repo: task.repos[0]?.path ?? '', command: '', timeoutMs: 600_000, required: true }])}
        >{t('ContractPanel.addCheck')}</button>
      </div>
      <div className="contract-checks">
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={ratchet !== null}
            onChange={(event) => patchVerification({
              ratchet: event.target.checked ? { direction: 'maximize', target: null } : null
            })}
          />
          <span className="switch-track" aria-hidden="true" />
          <span>{t('ContractPanel.ratchet')}</span>
        </label>
        {ratchet && (
          <>
            <p className="muted">{t('ContractPanel.ratchetHint')}</p>
            <div className="contract-grid">
              <select
                className="input"
                value={ratchet.direction}
                onChange={(event) => {
                  const parsed = RatchetDirection.safeParse(event.target.value)
                  if (parsed.success) patchVerification({ ratchet: { ...ratchet, direction: parsed.data } })
                }}
              >
                <option value="maximize">{t('ContractPanel.ratchetMaximize')}</option>
                <option value="minimize">{t('ContractPanel.ratchetMinimize')}</option>
              </select>
              <input
                type="number"
                step="any"
                className="input"
                value={ratchet.target ?? ''}
                placeholder={t('ContractPanel.ratchetTargetPlaceholder')}
                onChange={(event) => {
                  const raw = event.target.value.trim()
                  const num = raw === '' ? null : Number.parseFloat(raw)
                  patchVerification({ ratchet: { ...ratchet, target: num !== null && Number.isFinite(num) ? num : null } })
                }}
              />
            </div>
          </>
        )}
      </div>
      <div className="contract-checks">
        <span>{t('ContractPanel.humanItems')}</span>
        {human.map((entry, index) => (
          <div className="contract-human-row" key={index}>
            <input
              className="input"
              value={entry}
              placeholder={t('ContractPanel.humanPlaceholder')}
              onChange={(event) => setHuman(human.map((each, at) => at === index ? event.target.value : each))}
            />
            <button type="button" className="button ghost" aria-label={t('ContractPanel.removeCheck')} onClick={() => setHuman(human.filter((_, at) => at !== index))}>×</button>
          </div>
        ))}
        <button type="button" className="button ghost" onClick={() => setHuman([...human, ''])}>{t('ContractPanel.addHuman')}</button>
      </div>
      <div className="contract-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void save({
            ...draft,
            verification: {
              ...verification,
              checks: checks.filter((check) => check.repo && check.command.trim()),
              human: human.map((entry) => entry.trim()).filter(Boolean)
            }
          })}
        >{t('ContractPanel.save')}</button>
        {saved && <span className="muted">{t('ContractPanel.saved')}</span>}
      </div>
    </section>
  )
}
