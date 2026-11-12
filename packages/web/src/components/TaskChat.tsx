import { getLocale, t, tr } from '../i18n'
import { useEffect, useMemo, useState } from 'react'
import { checkChatResume, shortTaskId, type AgentKind, type Task } from '@conclave/protocol'
import { usePlans, type PlanItem } from '../chat-state'
import { loadConversation, perform, showInspectorFile, showTaskChanges, showTaskPlan, useChatOptionsSupported, useCore, useWireLogShown } from '../core-store'
import { insideProjects, locateInspectorFile } from '../inspector-file'
import { agentLabel, reasonText, STATUS_LABEL } from '../labels'
import { waitingOn } from '../task-waiting'
import { confirmQuota } from './AgentQuota'
import { BranchStatus } from './BranchStatus'
import type { ChatSurface } from './chat-surface'
import { ConversationChat } from './ConversationChat'
import { primaryProjectName } from './ProjectPicker'
import { DEFAULT_SIDE_PANEL_RATIO } from './side-panel-size'
import { SourceLink } from './SourceLink'
import { StatusIcon } from './StatusIcon'
import { TaskInspector } from './TaskInspector'
import { TaskAlerts } from './TaskAlerts'
import { TaskToolbar } from './TaskActions'
import { Spinner } from './Spinner'
import { BoardCrumb } from './TaskBoard'
import { useTaskHandoff } from './TaskHandoff'

// What the task kept of a plan in its chat: saved for when it can run. An approved one reads as its
// answer already does, so it needs no word.
function planNote(task: Task, item: PlanItem): string | null {
  const { plan } = task
  const kept = plan && plan.stageId === item.stageId && plan.requestId === item.requestId
  return kept && !plan.approved ? t('TaskChat.savedExecuteAfterDependenciesFinish') : null
}

// A message to a task's chat goes through the task first unless its agent is at work: the task checks
// what it may do, lays its worktrees out and goes back to running. A planning agent is checked every
// time, as the task's projects may change while it plans and it should follow them.
function taskSurface(task: Task, dependencies: readonly Task[], planOnly: boolean, bypassable: boolean, handoff: ((agent?: AgentKind) => void) | null): ChatSurface {
  const blocker = checkChatResume(task, dependencies)
  return {
    inspector: 'task',
    showPlan: showTaskPlan,
    showChanges: showTaskChanges,
    showFileChange: (path, edit) => {
      const conversation = task.conversationId ? useCore.getState().conversations[task.conversationId] : undefined
      if (!conversation) return
      const projects = task.repos.flatMap((repo) => repo.worktreePath ? [{ project: repo.path, folder: repo.worktreePath }] : [])
      const found = locateInspectorFile(path, conversation.workspacePath, projects)
      if (found) showInspectorFile('task', task.id, found.project, found.file, edit)
    },
    inProject: (path) => {
      const conversation = task.conversationId ? useCore.getState().conversations[task.conversationId] : undefined
      const folders = task.repos.flatMap((repo) => repo.worktreePath ? [repo.worktreePath] : [])
      return conversation ? insideProjects(path, conversation.workspacePath, folders) : false
    },
    changes: task.repos.some((repo) => repo.worktreePath !== null) ? { kind: 'task', id: task.id } : null,
    changesHint: t('TaskChat.uncommittedTaskWorktreeChangesClickToViewIn'),
    prepareSend: async (stopped) => {
      if (!stopped && task.status === 'running') return true
      if (stopped && task.agent && !confirmQuota(task.agent)) return false
      const allowBypass = bypassable ? { allowBypass: true } : {}
      return Boolean(await perform((rpc) => rpc.call('tasks.resumeChat', { id: task.id, ...allowBypass })))
    },
    sendBlocker: blocker && reasonText(blocker, blocker),
    savePlan: planOnly
      ? async (item) => {
          await perform((rpc) => rpc.call('tasks.savePlan', { id: task.id, stageId: item.stageId, requestId: item.requestId }))
        }
      : null,
    planNote: (item) => planNote(task, item),
    handoff,
    fork: null
  }
}

// A started task: its chat, the task's own header and toolbar above, and the task's inspector beside
// it with the plans its agent proposed.
export function TaskChat({ taskId }: { taskId: string }) {
  const task = useCore((s) => s.tasks[taskId])
  const tasks = useCore((s) => s.tasks)
  const conversationId = task?.conversationId ?? null
  const conversation = useCore((s) => (conversationId ? s.conversations[conversationId] : undefined))
  const inspectorOpen = useCore((s) => s.inspectorOpen)
  const starting = useCore((s) => s.startingTasks.includes(taskId))
  const bypassable = useChatOptionsSupported()
  const [sidePanelRatio, setSidePanelRatio] = useState(DEFAULT_SIDE_PANEL_RATIO)
  const plans = usePlans(conversationId ?? '')
  const wire = useWireLogShown() && conversationId !== null
  const handoff = useTaskHandoff(task)
  const { open: openHandoff } = handoff
  const handoffNow = handoff.available && handoff.blocker === null

  useEffect(() => {
    if (conversationId && !conversation) void loadConversation(conversationId)
  }, [conversationId, conversation])

  // Handed in for review, the task opens on what it changed.
  const status = task?.status
  useEffect(() => {
    if (status === 'review') showTaskChanges()
  }, [status])

  const dependencies = useMemo(
    () => (task ? task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined) : []),
    [task, tasks, getLocale()]
  )
  const surface = useMemo(
    () => (task ? taskSurface(task, dependencies, conversation?.planOnly ?? false, bypassable, handoffNow ? (agent?: AgentKind) => openHandoff(agent) : null) : null),
    [task, dependencies, conversation?.planOnly, bypassable, handoffNow, openHandoff, getLocale()]
  )
  if (!task || !surface) {
    return null
  }
  const worktree = task.repos.some((repo) => repo.worktreePath !== null)
  const showInspector = inspectorOpen && (conversationId !== null || worktree || plans.length > 0 || wire)

  return (
    <section className="detail terminal-view" aria-label={t('TaskChat.chat', { value1: task.title })}>
      <header className="detail-header task-terminal-header">
        <BoardCrumb />
        <StatusIcon status={task.status} waiting={waitingOn(task, tasks)} decorative />
        <div className="header-meta">
          <span className="terminal-view-title" title={task.title}>
            {task.title}
          </span>
          {task.agent && <span className="muted">{agentLabel(task.agent)}</span>}
          {task.repos.length > 0 && (
            <span className="muted" title={task.repos.map((repo) => repo.path).join('\n')}>
              {primaryProjectName(task.repos.map((repo) => repo.path))}
            </span>
          )}
          <BranchStatus target={{ kind: 'task', id: task.id }} updatedAt={task.updatedAt} />
          <span className="status-pill" data-status={task.status}>
            {STATUS_LABEL[task.status]}
          </span>
          <TaskAlerts task={task} />
          <span className="muted mono">{shortTaskId(task.id)}</span>
          <SourceLink source={task.source} />
          {conversation?.planOnly && <span className="task-tag task-tag-refining">{t('TaskChat.readOnlyPlanning')}</span>}
        </div>
        <TaskToolbar task={task} view="chat" />
      </header>
      <div className="terminal-body">
        {conversation ? (
          <ConversationChat conversation={conversation} surface={surface} />
        ) : starting ? (
          // Before core has the chat: it is getting the code and the agent ready, which can take a while.
          <div className="task-chat-starting" role="status">
            <Spinner />
            <span>{tr('TaskChat.startingSyncingCodeAndPreparingWorkspaceThisMay', { value1: task.agent ? agentLabel(task.agent) : 'Agent' })}</span>
          </div>
        ) : (
          <p className="terminal-view-empty muted">{t('TaskChat.loadingChatHistory')}</p>
        )}
        {showInspector && (
          <TaskInspector
            task={task}
            widthRatio={sidePanelRatio}
            onWidthRatioChange={setSidePanelRatio}
            plans={plans}
            planNote={(item) => planNote(task, item)}
            wire={wire}
          />
        )}
      </div>
    </section>
  )
}
