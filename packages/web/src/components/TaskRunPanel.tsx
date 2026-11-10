import { localized, t } from '../i18n'
import type { Flow, Task } from '@conclave/protocol'
import { setInspectorOpen, setTaskInspectorTab, useCore } from '../core-store'
import { useTaskFlows } from '../task-flows'
import { runSummary } from './task-run'
import { flowWorktree } from './flow-trajectory'

const RUN_STATE: Record<Flow['state'], string> = localized(() => ({
  running: t('FlowPanel.state.running'),
  review: t('FlowPanel.state.review'),
  paused: t('FlowPanel.state.paused'),
  failed: t('FlowPanel.state.failed'),
  cancelled: t('FlowPanel.state.cancelled'),
  waiting_environment: '等待环境'
}))

// The way into a run from the task itself. The trajectory lives in the inspector, which is not
// where a task page starts, so a run could be invisible from here entirely.
export function TaskRunPanel({ task }: { task: Task }) {
  const supported = useCore((state) => state.rpc?.features.includes('flows') ?? false)
  const { flows, loading } = useTaskFlows(task.id)
  const flow = flows[0] ?? null
  const summary = runSummary(task, flow)
  if (!supported || loading || !summary.visible) return null
  const worktree = flowWorktree(task)
  const open = () => {
    setInspectorOpen(true)
    setTaskInspectorTab('flow')
  }
  return (
    <section className="contract-panel run-panel">
      <header className="contract-heading">
        <strong>{t('RunPanel.title')}</strong>
        {summary.state && <span className="squad-state" data-state={summary.state === 'review' ? 'done' : summary.state}>{RUN_STATE[summary.state]}</span>}
        <button type="button" className="button ghost run-panel-open" onClick={open}>
          {summary.canStart ? t('RunPanel.start') : t('RunPanel.open')}
        </button>
      </header>
      {flow ? (
        <p className="muted run-panel-summary">
          <span>{t('RunPanel.summary', { value1: summary.attempts, value2: summary.steps })}</span>
          {summary.hiddenTests !== null && <span>{t('RunPanel.hidden', { value1: summary.hiddenTests })}</span>}
        </p>
      ) : (
        <p className="muted">{t('RunPanel.empty')}</p>
      )}
      {flow && worktree && (
        <p className="run-panel-worktree">
          <span className="mono">{worktree.branch}</span>
          <span className="muted mono">{worktree.path}</span>
        </p>
      )}
      {summary.note && <p className="flow-note run-panel-note">{summary.note}</p>}
    </section>
  )
}
