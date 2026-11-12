import { PullRequestPanel } from './PullRequestPanel'
import { t, tr } from '../i18n'
import { FlowPanel } from './FlowPanel'
import { GitInspector } from './GitInspector'
import { useEffect, useState } from 'react'
import type { RepoChanges, Task } from '@conclave/protocol'
import { pathShortener, type PlanItem } from '../chat-state'
import { clearInspectorFile, setInspectorOpen, setTaskInspectorTab, showInspectorFile, showTaskPlan, useCore } from '../core-store'
import { ProjectGroups, ProjectRow, useProjectHeads } from './BranchStatus'
import { ChatPlanView } from './ChatPlan'
import { ChangedFiles, CommitList, FileDiffView, GIT_TABS, InspectorPanel, type InspectorTab } from './Inspector'
import { projectName } from './ProjectPicker'
import { WireLogView } from './WireLogView'
import { DiffCommentConversation } from './DiffComments'
import { useTaskChanges } from '../task-changes'

function ChangeList({ changes, onOpen }: { changes: RepoChanges[] | null; onOpen: (repo: string, file: string) => void }) {
  if (changes === null) return <p className="inspector-empty muted">{t('ConversationInspector.loadingChanges')}</p>
  const compared = changes.filter((repo) => repo.base)
  if (compared.length === 0) return <p className="inspector-empty muted">{t('TaskInspector.thisTaskHasNoWorktreeYetAgentChanges')}</p>
  return (
    <div className="branch-status inspector-repos">
      <ProjectGroups items={compared}>
        {(repo, primary) => (
          <section key={repo.path} className="branch-status-project inspector-repo" data-primary={primary || undefined} aria-label={projectName(repo.path)}>
            <ProjectRow path={repo.path} branch={repo.branch}>
              <span className="inspector-row-since">{tr('TaskInspector.since', { value1: <span className="mono">{repo.base}</span> })}</span>
            </ProjectRow>
            <CommitList commits={repo.commits} label={t('GitInspector.commit')} />
            <ChangedFiles label={t('TaskInspector.changes')} files={repo.files} empty={t('TaskInspector.noChangesFromStartingPoint')} onOpen={(file) => onOpen(repo.path, file)} />
          </section>
        )}
      </ProjectGroups>
    </div>
  )
}


// Beside the terminal: what the agent changed since its branch started, to judge a result under
// review before accepting it.
// A chat task's inspector also shows the plans its agent proposed, and has no git to show while the
// task only plans.
export function TaskInspector({ task, widthRatio, onWidthRatioChange, plans = [], planNote, wire = false }: {
  task: Task
  widthRatio: number
  onWidthRatioChange: (ratio: number) => void
  plans?: readonly PlanItem[]
  planNote?: (item: PlanItem) => string | null
  // The raw traffic with the task's chat agent (settings → 调试).
  wire?: boolean
}) {
  const rpc = useCore((state) => state.rpc)
  const wanted = useCore((state) => state.taskInspectorTab)
  const selectedPlan = useCore((state) => state.taskInspectorPlan)
  const flowsSupported = useCore((state) => state.rpc?.features.includes('flows') ?? false)
  const worktree = task.repos.some((repo) => repo.worktreePath !== null)
  const tabs: InspectorTab[] = [...(flowsSupported ? ['flow' as const] : []), ...(worktree ? GIT_TABS : []), ...(plans.length > 0 ? ['plan' as const] : []), ...(wire && task.conversationId ? ['wire' as const] : []), ...(task.conversationId ? ['pull-request' as const] : [])]
  const tab = tabs.includes(wanted) ? wanted : (tabs[0] ?? 'changes')
  const [refreshCount, setRefreshCount] = useState(0)
  const [gitMaximized, setGitMaximized] = useState(false)
  useEffect(() => { setGitMaximized(false) }, [wanted, task.id])

  const selected = useCore((state) => state.inspectorFile?.kind === 'task' && state.inspectorFile.id === task.id ? state.inspectorFile : null)
  const selectedFolder = task.repos.find((repo) => repo.path === selected?.project)?.worktreePath
  const changes = useTaskChanges(task.id, task.updatedAt, refreshCount)
  const heads = useProjectHeads({ kind: 'task', id: task.id }, task.updatedAt, refreshCount)
  const fileCount = changes?.reduce((sum, repo) => sum + repo.files.length, 0) ?? 0
  return (
    <InspectorPanel
      label={t('TaskInspector.taskInspector')}
      maximized={tab === 'branch' && gitMaximized}
      ratio={widthRatio}
      onRatioChange={onWidthRatioChange}
      tabs={tabs}
      tab={tab}
      onTab={setTaskInspectorTab}
      fileCount={fileCount}
      onRefresh={() => setRefreshCount((count) => count + 1)}
      onClose={() => setInspectorOpen(false)}
    >
      <DiffCommentConversation.Provider value={task.conversationId}>
        {tab === 'pull-request' && task.conversationId ? (
          <PullRequestPanel key={task.id} conversationId={task.conversationId} initialUrl={task.source?.provider === 'github' && /\/pull\/[1-9][0-9]*\/?$/.test(task.source.url) ? task.source.url : ''} />
        ) : tab === 'flow' ? (
          <FlowPanel task={task} />
        ) : tab === 'wire' && task.conversationId ? (
          <WireLogView conversationId={task.conversationId} />
        ) : tab === 'plan' ? (
          <ChatPlanView conversationId={task.conversationId ?? null} plans={plans} selected={selectedPlan} onSelect={showTaskPlan} note={planNote} />
        ) : tab === 'branch' ? (
          <GitInspector target={{ kind: 'task', id: task.id }} heads={heads} updatedAt={task.updatedAt} refresh={refreshCount} maximized={gitMaximized} onMaximize={() => setGitMaximized((value) => !value)} />
        ) : selected && rpc ? (
          <FileDiffView
            file={selectedFolder ? pathShortener([selectedFolder])(selected.file) : selected.file}
            loadKey={`${task.id}\0${selected.project}\0${selected.file}\0${selected.revision}\0${refreshCount}`}
            commentKey={`task:${task.id}\0${selected.project}\0${selected.file}`}
            load={() => rpc.call('tasks.diff', { id: task.id, repo: selected.project, file: selected.file })}
            onBack={clearInspectorFile}
            edit={selected.edit}
          />
        ) : (
          <ChangeList changes={changes} onOpen={(repo, file) => showInspectorFile('task', task.id, repo, file)} />
        )}
      </DiffCommentConversation.Provider>
    </InspectorPanel>
  )
}
