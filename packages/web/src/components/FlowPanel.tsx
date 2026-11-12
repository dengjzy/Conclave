import { useEffect, useState } from 'react'
import type { Flow, FlowAttempt, FlowNode, Task } from '@conclave/protocol'
import { localized, t } from '../i18n'
import { perform, setInspectorOpen, setTaskInspectorTab, showInspectorFile, showView, useCore } from '../core-store'
import { AgentIcon, ChevronRightIcon } from './icons'
import { Spinner } from './Spinner'
import { durationText } from '../stat-format'
import { flowChangeSummary, flowGlyph, flowWorktree } from './flow-trajectory'
import { FileList } from './Inspector'
import { useTaskChanges } from '../task-changes'
import { useTaskFlows } from '../task-flows'

const FLOW_STATE: Record<Flow['state'], string> = localized(() => ({
  running: t('FlowPanel.state.running'),
  review: t('FlowPanel.state.review'),
  paused: t('FlowPanel.state.paused'),
  failed: t('FlowPanel.state.failed'),
  cancelled: t('FlowPanel.state.cancelled'),
  waiting_environment: t('FlowPanel.state.waitingEnvironment')
}))

const NODE_STATE: Record<FlowNode['state'], string> = localized(() => ({
  pending: t('FlowPanel.nodeState.pending'),
  running: t('FlowPanel.nodeState.running'),
  done: t('FlowPanel.nodeState.done'),
  failed: t('FlowPanel.nodeState.failed'),
  skipped: t('FlowPanel.nodeState.skipped')
}))

const NODE_KIND: Record<FlowNode['kind'], string> = localized(() => ({
  plan: t('FlowPanel.node.plan'),
  implement: t('FlowPanel.node.implement'),
  verify: t('FlowPanel.node.verify'),
  gate: t('FlowPanel.node.gate')
}))

const FAILURE_KIND: Record<NonNullable<FlowAttempt['failureKind']>, string> = localized(() => ({
  compile: t('FlowPanel.failure.compile'),
  test: t('FlowPanel.failure.test'),
  environment: t('FlowPanel.failure.environment'),
  unknown: t('FlowPanel.failure.unknown')
}))

const RESULT: Record<NonNullable<FlowAttempt['result']>, string> = localized(() => ({
  pass: t('FlowPanel.result.pass'),
  fail: t('FlowPanel.result.fail')
}))

function parseEnvLines(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1)
    if (key) env[key] = value
  }
  return env
}

function EnvironmentSupplyCard({ flow }: { flow: Flow }) {
  const mcpServers = useCore((state) => state.mcpServers)
  const demand = flow.demand
  const [selectedMcp, setSelectedMcp] = useState<string[]>([])
  const [envText, setEnvText] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelectedMcp(
      demand?.type === 'mcp' && mcpServers.some((server) => server.name === demand.target)
        ? [demand.target]
        : []
    )
    setEnvText(demand?.type === 'env_var' ? `${demand.target}=` : '')
    setNote('')
  }, [flow.id, demand?.id, demand?.type, demand?.target, mcpServers])

  const submit = async () => {
    setBusy(true)
    try {
      const env = parseEnvLines(envText)
      await perform((rpc) => rpc.call('flows.supplyEnvironment', {
        id: flow.id,
        ...(selectedMcp.length > 0 ? { mcpServers: selectedMcp } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(note.trim() ? { note: note.trim() } : {})
      }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flow-env-supply">
      <div className="flow-env-header">
        <strong>{t('FlowPanel.envTitle')}</strong>
        {demand && <span className="task-tag mono">{`${demand.type}:${demand.target}`}</span>}
      </div>
      {demand && (
        <div className="flow-env-demand">
          <p className="flow-note">{demand.reason}</p>
          {demand.suggestion && <p className="muted">{demand.suggestion}</p>}
        </div>
      )}
      {mcpServers.length > 0 && (
        <div className="contract-field">
          <span>{t('FlowPanel.envMcp')}</span>
          <div className="flow-env-mcp-list">
            {mcpServers.map((server) => {
              const checked = selectedMcp.includes(server.name)
              return (
                <label key={server.name} className="flow-env-mcp-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setSelectedMcp((current) =>
                      event.target.checked ? [...current, server.name] : current.filter((name) => name !== server.name)
                    )}
                  />
                  <span>{server.name}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}
      <label className="contract-field">
        <span>{t('FlowPanel.envVars')}</span>
        <textarea
          className="input mono"
          rows={2}
          placeholder="API_KEY=..."
          value={envText}
          onChange={(event) => setEnvText(event.target.value)}
        />
      </label>
      <label className="contract-field">
        <span>{t('FlowPanel.envNote')}</span>
        <input
          className="input"
          placeholder={t('FlowPanel.envNotePlaceholder')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="contract-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => void submit()}>
          {busy ? <Spinner /> : null}
          {t('FlowPanel.envSubmit')}
        </button>
      </div>
    </div>
  )
}

function AttemptRow({ attempt }: { attempt: FlowAttempt }) {
  const [open, setOpen] = useState(false)
  const ended = attempt.state !== 'running'
  return (
    <li className="squad-work" data-open={open || undefined}>
      <div className="squad-work-row">
        <button type="button" className="squad-work-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <AgentIcon agent={attempt.agent} />
          <span className="squad-work-text">
            <span className="muted">{t('FlowPanel.attempt', { value1: attempt.number })}</span>
            {attempt.agent ?? t('FlowPanel.noAgent')}
          </span>
        </button>
        <span className="squad-work-status">
          {attempt.metricScore != null && <span className="task-tag mono">{t('FlowPanel.metricScore', { value1: attempt.metricScore })}</span>}
          {attempt.state === 'running' ? <span className="squad-state" data-state="running"><Spinner />{NODE_STATE.running}</span>
            : <span className="squad-state" data-state={attempt.result === 'pass' ? 'done' : 'failed'}>{attempt.result ? RESULT[attempt.result] : NODE_STATE[attempt.state]}</span>}
          {attempt.failureKind && <span className="muted">{FAILURE_KIND[attempt.failureKind]}</span>}
          {ended && <span className="squad-clock">{durationText(attempt.endedAt ? attempt.endedAt - attempt.startedAt : null)}</span>}
        </span>
      </div>
      {open && attempt.error && <div className="squad-work-detail"><pre className="flow-error">{attempt.error}</pre></div>}
    </li>
  )
}

function FlowWorktree({ task }: { task: Task }) {
  const worktree = flowWorktree(task)
  const summary = flowChangeSummary(useTaskChanges(task.id, task.updatedAt, 0))
  const [open, setOpen] = useState(false)
  if (!worktree) return null
  return <div className="flow-worktree">
    <div className="flow-worktree-row">
      <span className="flow-worktree-branch" title={worktree.path}>{worktree.branch}</span>
      <span className="flow-worktree-path" title={worktree.path}>{worktree.path}</span>
      {worktree.base && <span className="flow-worktree-base">{`← ${worktree.base}`}</span>}
      {summary !== null && summary.files === 0 && <span className="flow-worktree-count muted">{t('FlowPanel.noChanges')}</span>}
      {summary !== null && summary.files > 0 && (
        <button type="button" className="flow-worktree-count flow-worktree-diff" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRightIcon />
          {t('FlowPanel.diffFiles', { value1: summary.files })}
          <span className="chat-diff-added">+{summary.added}</span>
          <span className="chat-diff-removed">−{summary.removed}</span>
        </button>
      )}
      <button type="button" className="flow-worktree-action" onClick={() => { setInspectorOpen(true); setTaskInspectorTab('changes'); showView('chat') }}>{t('FlowPanel.viewChanges')}</button>
    </div>
    {open && summary !== null && summary.files > 0 && (
      <div className="flow-worktree-files">
        {summary.repos.map((each) => (
          <FileList key={each.repo} files={each.files} onOpen={(file) => showInspectorFile('task', task.id, each.repo, file)} />
        ))}
      </div>
    )}
  </div>
}

// A task's autonomous run: what it is doing, which agent did which attempt, and why it stopped.
export function FlowPanel({ task, inline = false }: { task: Task; inline?: boolean }) {
  const { flows, loading } = useTaskFlows(task.id)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const flow = flows.find((each) => each.id === selectedId) ?? flows[0] ?? null
  const [busy, setBusy] = useState(false)

  const act = async (action: 'cancel' | 'resume' | 'start') => {
    setBusy(true)
    try {
      if (action === 'start') await perform((rpc) => rpc.call('flows.start', { id: task.id }))
      else if (flow) await perform((rpc) => rpc.call('flows.control', { id: flow.id, action }))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return inline ? null : <p className="inspector-empty muted">{t('FlowPanel.loading')}</p>

  if (!flow) {
    if (inline) return null
    return (
      <div className="flow-empty">
        <p className="muted">{task.status === 'pending' ? t('FlowPanel.startHint') : t('FlowPanel.noFlow')}</p>
        {task.status === 'pending' && (
          <button type="button" className="button" disabled={busy || !task.agent || task.repos.length === 0} onClick={() => void act('start')}>
            {busy ? <><Spinner />{t('FlowPanel.starting')}</> : t('FlowPanel.start')}
          </button>
        )}
      </div>
    )
  }

  return (
    <section className="squad-run flow-panel">
      <header className="squad-run-heading">
        <strong>{t('FlowPanel.title')}</strong>
        {flows.length > 1 && <select className="input flow-history" aria-label={t('FlowPanel.history')} value={flow.id} onChange={(event) => setSelectedId(event.target.value)}>{flows.map((each, index) => <option key={each.id} value={each.id}>{`#${flows.length - index} · ${FLOW_STATE[each.state]}`}</option>)}</select>}
        <span className="muted">{FLOW_STATE[flow.state]}</span>
        {flow.bestScore != null && <span className="task-tag mono">{t('FlowPanel.bestScore', { value1: flow.bestScore })}</span>}
        <span className="flow-actions">
          {(flow.state === 'paused' || flow.state === 'failed') && <button type="button" className="button ghost" disabled={busy} onClick={() => void act('resume')}>{t('FlowPanel.resume')}</button>}
          {(flow.state === 'running' || flow.state === 'paused' || flow.state === 'waiting_environment') && <button type="button" className="button ghost" disabled={busy} onClick={() => void act('cancel')}>{t('FlowPanel.stop')}</button>}
        </span>
      </header>
      <FlowWorktree task={task} />
      <div className="flow-meta muted">
        {flow.testAuthor === 'running' && <span>{t('FlowPanel.authoring')}</span>}
        {flow.testAuthor === 'failed' && <span>{t('FlowPanel.authorFailed')}</span>}
        {flow.hiddenTests && <span>{t('FlowPanel.hiddenCount', { value1: flow.hiddenTests.files.length })}</span>}
        {flow.redFirst !== 'skipped' && <span>{t('FlowPanel.redFirst', { value1: flow.redFirst })}</span>}
      </div>
      {flow.state === 'waiting_environment' && <EnvironmentSupplyCard flow={flow} />}
      {flow.note && flow.state !== 'waiting_environment' && <p className="modal-error flow-note">{flow.note}</p>}
      {flow.replan && <details className="flow-report" open><summary>{t('FlowPanel.replan')}</summary><p className="flow-note">{flow.replan.diagnosis}</p><p className="flow-note">{flow.replan.instruction}</p>{flow.replan.steps.length > 0 && <ol className="flow-steps">{flow.replan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}</details>}
      {flow.report && <details className="flow-report"><summary>{t('FlowPanel.report')}</summary><pre className="flow-error">{flow.report}</pre></details>}
      <ol className="flow-trajectory" aria-label={t('FlowPanel.nodes')}>
        {flow.nodes.map((node) => (
          <li key={node.id} className="flow-trajectory-node" data-state={node.state}>
            <span className="flow-trajectory-glyph" aria-hidden="true">{flowGlyph(node.kind, node.state)}</span>
            <div className="flow-trajectory-body">
              <div className="flow-trajectory-heading">
                <strong>{NODE_KIND[node.kind]}</strong>
                {node.agent && <span className="flow-trajectory-agent"><AgentIcon agent={node.agent} />{node.agent}</span>}
                <span className="flow-trajectory-state" data-state={node.state}>{node.state === 'running' ? <><Spinner />{NODE_STATE.running}</> : NODE_STATE[node.state]}</span>
              </div>
              {node.instruction && node.kind !== 'verify' && <p className="flow-trajectory-instruction">{node.instruction}</p>}
              {node.attempts > 0 && <span className="flow-trajectory-attempts">{t('FlowPanel.attempt', { value1: node.attempts })}</span>}
            </div>
          </li>
        ))}
      </ol>
      {flow.attempts.length > 0 && (
        <div className="squad-works">
          <h3 className="squad-works-heading"><span>{t('FlowPanel.attempts')}</span></h3>
          <ul>{flow.attempts.map((attempt) => <AttemptRow key={attempt.id} attempt={attempt} />)}</ul>
        </div>
      )}
    </section>
  )
}
