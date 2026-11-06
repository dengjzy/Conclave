import { useState } from 'react'
import type { Task } from '@conclave/protocol'
import { openTerminal, selectTask, showTaskChanges, showView } from '../core-store'
import { focusWorkflowTask } from '../task-board'
import { t } from '../i18n'
import { CopyButton } from './CopyButton'
import { projectName } from './ProjectPicker'
import { ChevronDownIcon } from './icons'

export function TaskWorktreeCard({ task }: { task: Task }) {
  const [open, setOpen] = useState(true)
  if (task.repos.length === 0 && !task.workflow) return null

  const hasWorktree = task.repos.some((repo) => repo.worktreePath !== null)

  return (
    <section className="snapshot task-worktree-card" data-open={open || undefined} aria-label="工作树与执行状态">
      <header className="snapshot-header" style={{ justifyContent: 'space-between', padding: '6px 10px' }}>
        <button type="button" className="snapshot-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDownIcon />
          <span>{task.workflow ? `车道工作树 · ${task.workflow.lane}` : '工作树与上下文'}</span>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {task.workflow && (
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                focusWorkflowTask(task.id)
                selectTask(null)
              }}
              title="在泳道中对焦查看"
            >
              对焦泳道 ↗
            </button>
          )}
          {hasWorktree && (
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                showView('chat')
                showTaskChanges()
              }}
            >
              {t('Workflow.changes')}
            </button>
          )}
        </div>
      </header>
      {open && (
        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
          {task.workflow && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)' }}>
              <span>所属需求:</span>
              <strong style={{ color: 'var(--text)' }}>{task.workflow.title}</strong>
              <span className="task-board-chip" style={{ fontSize: '11px', padding: '1px 6px' }}>
                车道: {task.workflow.lane}
              </span>
            </div>
          )}
          <div className="workflow-worktrees">
            {task.repos.map((repo) => (
              <div key={repo.path} style={{ background: 'var(--surface)', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600 }}>{projectName(repo.path)}</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {repo.worktreePath ? (
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => void openTerminal(repo.worktreePath!)}
                        title="在独立工作树中打开终端"
                      >
                        终端
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => void openTerminal(repo.path)}
                        title="在主工程目录打开终端"
                      >
                        终端
                      </button>
                    )}
                  </div>
                </div>
                {repo.worktreePath ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                      <span className="muted" style={{ minWidth: '48px' }}>分支:</span>
                      <code>{repo.branch ?? '—'}</code>
                    </div>
                    <div className="workflow-path" style={{ marginTop: '2px' }}>
                      <span className="muted" style={{ minWidth: '48px' }}>工作树:</span>
                      <code>{repo.worktreePath}</code>
                      <CopyButton text={repo.worktreePath} />
                    </div>
                  </>
                ) : (
                  <div style={{ marginTop: '4px', color: 'var(--text-muted)' }}>
                    <span>{task.workflow ? t('Workflow.createdOnStart') : '使用工程主目录 (启动时若支持独立工作树将自动切入)'}</span>
                  </div>
                )}
                {repo.start && (
                  <div style={{ marginTop: '2px', color: 'var(--text-muted)', fontSize: '11px' }}>
                    <span>起点提交: <code>{repo.start.commit.slice(0, 8)}</code></span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
