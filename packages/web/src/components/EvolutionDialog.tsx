import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { AgentKind, type EvolutionGeneration, type FrictionItem } from '@conclave/protocol'
import { localized, t } from '../i18n'
import { dismissError, perform, selectTask, setEvolutionOpen, useCore } from '../core-store'
import { useInstalledAgents } from '../installed-agents'
import { agentLabel } from '../labels'
import { AgentIcon, CloseIcon } from './icons'
import { Spinner } from './Spinner'

const GEN_STATE: Record<EvolutionGeneration['state'], string> = localized(() => ({
  running: t('EvolutionDialog.state.running'),
  passed: t('EvolutionDialog.state.passed'),
  failed: t('EvolutionDialog.state.failed'),
  merged: t('EvolutionDialog.state.merged')
}))

const ITEM_STATUS: Record<FrictionItem['status'], string> = localized(() => ({
  open: t('EvolutionDialog.status.open'),
  doing: t('EvolutionDialog.status.doing'),
  done: t('EvolutionDialog.status.done'),
  dropped: t('EvolutionDialog.status.dropped')
}))

export function EvolutionPanel({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const status = useCore((state) => state.evolutionStatus)
  const error = useCore((state) => state.error)
  const installed = useInstalledAgents()
  const [agent, setAgent] = useState<AgentKind | null>(null)
  const [adding, setAdding] = useState(false)
  const [summary, setSummary] = useState('')
  const [repro, setRepro] = useState('')
  const [expectText, setExpectText] = useState('')
  const [pathsText, setPathsText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void perform((rpc) => rpc.call('evolution.status', {})).then((fresh) => {
      if (fresh) useCore.setState({ evolutionStatus: fresh })
    })
  }, [])

  const openTask = (taskId: string) => {
    selectTask(taskId)
    onOpenTask?.(taskId)
  }

  const refresh = async () => {
    const fresh = await perform((rpc) => rpc.call('evolution.status', {}))
    if (fresh) useCore.setState({ evolutionStatus: fresh })
  }

  const trigger = async (frictionId?: string) => {
    setBusy(true)
    dismissError()
    try {
      const generation = await perform((rpc) => rpc.call('evolution.trigger', {
        ...(frictionId ? { frictionId } : {}),
        ...(agent ? { agent } : {})
      }))
      if (generation) await refresh()
    } finally {
      setBusy(false)
    }
  }

  const submitFriction = async (event: FormEvent) => {
    event.preventDefault()
    if (!summary.trim() || !repro.trim() || !expectText.trim()) return
    setBusy(true)
    dismissError()
    try {
      const paths = pathsText.split(',').map((entry) => entry.trim()).filter(Boolean)
      const created = await perform((rpc) => rpc.call('evolution.addFriction', {
        summary: summary.trim(),
        repro: repro.trim(),
        expect: expectText.trim(),
        ...(paths.length > 0 ? { paths } : {})
      }))
      if (created) {
        setSummary('')
        setRepro('')
        setExpectText('')
        setPathsText('')
        setAdding(false)
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const active = status?.activeGeneration ?? null
  const items = status?.items ?? []
  const recent = status?.recentGenerations ?? []

  return (
    <div className="evolution-workbench">
      <div className="evolution-meta">
        {status && (
          <span className="mono">
            {t('EvolutionDialog.staging', {
              value1: status.stagingBranch,
              value2: status.baseCommit ? status.baseCommit.slice(0, 8) : 'HEAD'
            })}
          </span>
        )}
        <p className="muted">{t('EvolutionDialog.gates')}</p>
      </div>

      {active && (
        <div className="evolution-active">
          <Spinner />
          <AgentIcon agent={active.agent} />
          <span>{t('EvolutionDialog.active', { value1: agentLabel(active.agent) })}</span>
          <button
            type="button"
            className="button ghost"
            onClick={() => openTask(active.taskId)}
          >
            {t('EvolutionDialog.openTask')}
          </button>
        </div>
      )}

      <div className="evolution-toolbar">
        <select
          className="input"
          aria-label={t('NewTaskDialog.assignee')}
          value={agent ?? ''}
          onChange={(event) => {
            const parsed = AgentKind.safeParse(event.target.value)
            setAgent(parsed.success ? parsed.data : null)
          }}
        >
          <option value="">{t('NewTaskDialog.autoAgent')}</option>
          {installed.map((kind) => (
            <option key={kind} value={kind}>{agentLabel(kind)}</option>
          ))}
        </select>
        <button
          type="button"
          className="button primary"
          disabled={busy || Boolean(active) || (status?.openFrictionCount ?? 0) === 0}
          onClick={() => void trigger()}
        >
          {busy && !adding ? <Spinner /> : null}
          {t('EvolutionDialog.trigger')}
        </button>
        <button
          type="button"
          className="button ghost"
          onClick={() => setAdding((current) => !current)}
        >
          {t('EvolutionDialog.addToggle')}
        </button>
      </div>

      {adding && (
        <form className="evolution-form" onSubmit={(event) => void submitFriction(event)}>
          <label className="contract-field">
            <span>{t('EvolutionDialog.summary')}</span>
            <input
              className="input"
              required
              placeholder={t('EvolutionDialog.summaryPlaceholder')}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <label className="contract-field">
            <span>{t('EvolutionDialog.repro')}</span>
            <textarea
              className="input"
              rows={2}
              required
              placeholder={t('EvolutionDialog.reproPlaceholder')}
              value={repro}
              onChange={(event) => setRepro(event.target.value)}
            />
          </label>
          <label className="contract-field">
            <span>{t('EvolutionDialog.expect')}</span>
            <input
              className="input"
              required
              placeholder={t('EvolutionDialog.expectPlaceholder')}
              value={expectText}
              onChange={(event) => setExpectText(event.target.value)}
            />
          </label>
          <label className="contract-field">
            <span>{t('EvolutionDialog.paths')}</span>
            <input
              className="input mono"
              placeholder="packages/core/src, packages/web/src"
              value={pathsText}
              onChange={(event) => setPathsText(event.target.value)}
            />
          </label>
          <div className="contract-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !summary.trim() || !repro.trim() || !expectText.trim()}
            >
              {busy ? <Spinner /> : null}
              {t('EvolutionDialog.addSubmit')}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="modal-error" role="alert">
          {error}
        </p>
      )}

      <section className="evolution-section">
        <h3>{t('EvolutionDialog.backlogTitle')}</h3>
        {items.length === 0 ? (
          <p className="muted">{t('EvolutionDialog.backlogEmpty')}</p>
        ) : (
          <ul className="evolution-list">
            {items.map((item) => (
              <li key={item.id} className="evolution-item" data-status={item.status}>
                <div className="evolution-item-row">
                  <span className="task-tag">{ITEM_STATUS[item.status]}</span>
                  <strong>{item.summary}</strong>
                  {item.status === 'open' && (
                    <button
                      type="button"
                      className="button ghost"
                      disabled={busy || Boolean(active)}
                      onClick={() => void trigger(item.id)}
                    >
                      {t('EvolutionDialog.triggerItem')}
                    </button>
                  )}
                </div>
                <p className="muted">{item.expect}</p>
                {item.paths.length > 0 && (
                  <span className="mono muted">{item.paths.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="evolution-section">
        <h3>{t('EvolutionDialog.historyTitle')}</h3>
        {recent.length === 0 ? (
          <p className="muted">{t('EvolutionDialog.historyEmpty')}</p>
        ) : (
          <ul className="evolution-list">
            {recent.map((gen) => (
              <li key={gen.id} className="evolution-item" data-state={gen.state}>
                <div className="evolution-item-row">
                  <AgentIcon agent={gen.agent} />
                  <span className="task-tag">{GEN_STATE[gen.state]}</span>
                  <span className="mono muted">{(gen.tip ?? gen.base).slice(0, 8)}</span>
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => openTask(gen.taskId)}
                  >
                    {t('EvolutionDialog.openTask')}
                  </button>
                </div>
                {gen.note && <p className="muted">{gen.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export function EvolutionDialog() {
  const dialog = useRef<HTMLDialogElement>(null)
  const ids = useId()
  const close = () => setEvolutionOpen(false)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
    }
    dismissError()
    return () => element?.close()
  }, [])

  const onBackdrop = (event: MouseEvent) => {
    if (event.target === dialog.current) close()
  }

  return (
    <dialog
      ref={dialog}
      className="modal evolution-dialog"
      aria-labelledby={`${ids}-heading`}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClick={onBackdrop}
    >
      <div className="modal-body evolution-body">
        <header className="new-task-header">
          <div className="new-task-breadcrumb">
            <span>Conclave</span>
            <span className="new-task-breadcrumb-separator" aria-hidden="true">›</span>
            <h2 id={`${ids}-heading`}>{t('EvolutionDialog.title')}</h2>
          </div>
          <div className="new-task-window-actions">
            <button type="button" className="icon-button" aria-label={t('BackdropPicker.close')} onClick={close}>
              <CloseIcon />
            </button>
          </div>
        </header>
        <EvolutionPanel onOpenTask={() => close()} />
      </div>
    </dialog>
  )
}
