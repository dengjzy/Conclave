import { useEffect, useState, type ReactNode } from 'react'
import { MAX_WORKFLOW_LANES, type Task } from '@conclave/protocol'
import { selectTask, showTaskChanges, showView, useCore } from '../core-store'
import { t } from '../i18n'
import type { WorkflowGroup } from '../workflow-board'
import { focusWorkflowTask, useBoardFilter } from '../task-board'
import { agentLabel, STATUS_LABEL } from '../labels'
import { StatusIcon } from './StatusIcon'
import { CopyButton } from './CopyButton'
import { projectName } from './ProjectPicker'
import { useTaskHandoff } from './TaskHandoff'
import { WorkflowProcess } from './WorkflowProcess'

export function WorkflowBoard({ groups, renderTask, onAdd, onNew }: {
  groups: readonly WorkflowGroup[]
  renderTask: (task: Task) => ReactNode
  onAdd: (task: Task) => void
  onNew: () => void
}) {
  const focusedTaskId = useBoardFilter((s) => s.focusedTaskId)
  const selectedTaskId = useCore((s) => s.selectedId)
  const targetTaskId = focusedTaskId ?? selectedTaskId
  const targetGroup = groups.find((entry) => entry.lanes.some((task) => task.id === targetTaskId))
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (targetGroup && targetGroup.id !== selected) {
      setSelected(targetGroup.id)
    }
  }, [targetGroup?.id])

  const group = (selected ? groups.find((entry) => entry.id === selected) : null) ?? targetGroup ?? groups[0]
  return <div className="workflow-board">
    {groups.length > 1 && <nav className="workflow-switch" aria-label={t('WorkflowStudio.workflows')}>{groups.map((entry) => <button type="button" className="button ghost" key={entry.id} aria-pressed={entry.id === group?.id} onClick={() => setSelected(entry.id)}>{entry.title}</button>)}</nav>}
    {!group && <div className="workflow-empty"><p>{t('Workflow.empty')}</p><button type="button" className="button" onClick={onNew}>{t('Workflow.new')}</button><p className="muted">{t('Workflow.ordinaryTasks')}</p></div>}
    {group && <section key={group.id} className="workflow-swimlane" aria-label={group.title}>
      <header className="workflow-heading"><h3>{group.title}</h3><span className="muted">{t('Workflow.count', { shown: group.lanes.length, total: group.total })}</span><button type="button" className="button ghost" disabled={group.total >= MAX_WORKFLOW_LANES} onClick={() => { const first = group.lanes[0]; if (first) onAdd(first) }}>{t('Workflow.addLane')}</button></header>
      <WorkflowProcess tasks={group.lanes} renderTask={(task) => <Lane task={task}>{renderTask(task)}</Lane>} autoFocusTaskId={targetTaskId} />
    </section>}
  </div>
}

function Lane({ task, children }: { task: Task; children: ReactNode }) {
  const focusedTaskId = useBoardFilter((s) => s.focusedTaskId)
  const isFocused = focusedTaskId === task.id
  const handoff = useTaskHandoff(task)
  const laneTitle = task.workflow?.lane ?? task.title
  return <section className="workflow-lane" data-focused={isFocused || undefined} aria-label={laneTitle}>
    <header><strong>{laneTitle}</strong><span className="muted">{task.agent ? agentLabel(task.agent) : t('TaskExecutorPicker.chooseLater')}</span><span className="workflow-lane-status"><StatusIcon status={task.status} decorative />{STATUS_LABEL[task.status]}</span></header>
    {children}
    <div className="workflow-worktrees">{task.repos.map((repo) => <div key={repo.path}>
      <span>{projectName(repo.path)}</span>
      {repo.worktreePath ? <><code>{repo.branch ?? '—'}</code><div className="workflow-path"><code>{repo.worktreePath}</code><CopyButton text={repo.worktreePath} /></div></> : <span className="muted">{t('Workflow.createdOnStart')}</span>}
      {repo.start && <span className="muted">{t('Workflow.base', { commit: repo.start.commit.slice(0, 8) })}</span>}
    </div>)}</div>
    <div className="workflow-lane-actions">
      {task.repos.some((repo) => repo.worktreePath) && <button type="button" className="button ghost" onClick={() => { selectTask(task.id); showView('chat'); showTaskChanges() }}>{t('Workflow.changes')}</button>}
      {handoff.available && <button type="button" className="button ghost" disabled={Boolean(handoff.blocker)} title={handoff.blocker ?? undefined} onClick={() => handoff.open()}>{t('Workflow.relay')}</button>}
    </div>
  </section>
}

export function WorkflowContext({ task, showProcess = true }: { task: Task; showProcess?: boolean }) {
  const tasks = useCore((s) => s.tasks)
  if (task.workflow) {
    const siblings = Object.values(tasks).filter((other) => other.workflow?.id === task.workflow?.id).sort((a, b) => (a.workflow?.position ?? 0) - (b.workflow?.position ?? 0))
    return (
      <>
        <nav className="workflow-context" aria-label={t('Workflow.siblings')}>
          <span title={task.workflow.title}>{task.workflow.title}</span>
          {siblings.map((other) => (
            <button
              type="button"
              key={other.id}
              className="button ghost"
              aria-current={other.id === task.id ? 'page' : undefined}
              onClick={() => selectTask(other.id)}
            >
              <StatusIcon status={other.status} decorative />
              {other.workflow?.lane}
            </button>
          ))}
          <button
            type="button"
            className="button ghost"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              focusWorkflowTask(task.id)
              selectTask(null)
            }}
            title={t('Workflow.focusSwimlane')}
          >
            {t('Workflow.focusSwimlane')} ↗
          </button>
        </nav>
        {showProcess && <WorkflowProcess tasks={siblings} compact autoFocusTaskId={task.id} />}
      </>
    )
  }

  return showProcess ? <WorkflowProcess tasks={[task]} compact autoFocusTaskId={task.id} /> : null
}
