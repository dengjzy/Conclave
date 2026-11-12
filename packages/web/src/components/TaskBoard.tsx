import { getLocale, localized, t, tr } from '../i18n'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { AGENT_KINDS, DEFAULT_INSTANCE, type AgentKind, type Task } from '@conclave/protocol'
import { timeAgo } from '../conversation-state'
import { selectTask, setInboxOpen, setNewTaskOpen, setSettingsOpen, useCore } from '../core-store'
import { agentLabel, STATUS_LABEL } from '../labels'
import { setPreference, TASK_SORTS, usePreferences } from '../preferences'
import { TASK_SHORTCUT_LABEL } from '../shortcut-keys'
import { activeInboxes, inboxKey } from '../source-inboxes'
import { boardColumns, boardProjects, type BoardColumn, type BoardFilter, type TaskSort } from '../task-board'
import { waitingOn } from '../task-waiting'
import { saveTaskText } from '../unsaved-edits'
import { AgendaSourceChannel } from './AgendaSourceChannel'
import { ChatPicker } from './ChatPicker'
import { menuPoint, type MenuPoint } from './ContextMenu'
import { EvolutionPanel } from './EvolutionDialog'
import { AgentIcon } from './icons'
import { projectName, projectNames } from './ProjectPicker'
import { Spinner } from './Spinner'
import { StatusIcon } from './StatusIcon'
import { cardAction, TaskContextMenu, useChatTurn } from './TaskActions'
import { TaskAlerts } from './TaskAlerts'
import { openQuickAdd, TaskQuickAdd } from './TaskQuickAdd'
import { TitleEditor } from './TitleEditor'
import { TaskActivity } from './TaskActivity'
import { TaskDependencies } from './TaskDependencies'
import { useTaskActivity } from '../work-activity'

export type AgendaChannel = 'all' | 'local' | 'evolution' | `source:${string}`
export type AgendaViewMode = 'board' | 'list'

export function BoardCrumb() {
  return (
    <span className="board-crumb">
      <button type="button" className="board-crumb-link" data-tooltip={t('TaskBoard.backToTaskBoardEsc')} onClick={() => selectTask(null)}>
        {t('GitInspector.task')}
      </button>
      <span className="board-crumb-sep" aria-hidden="true">/</span>
    </span>
  )
}

const SORT_LABEL: Record<TaskSort, string> = localized(() => ({
  recent: t('TaskBoard.byRecentActivity'),
  created: t('TaskBoard.byCreationTime'),
  title: t('TaskBoard.byTitle')
}))

const useBoardFilter = create<BoardFilter & { allDone: boolean; channel: AgendaChannel; viewMode: AgendaViewMode }>()(() => ({
  query: '',
  project: null,
  agent: null,
  allDone: false,
  channel: 'all',
  viewMode: 'board'
}))

export function setAgendaChannel(channel: AgendaChannel): void {
  useBoardFilter.setState({ channel })
}

function isEvolutionTask(task: Task): boolean {
  return task.title.startsWith('self:')
}

export function TaskBoard() {
  const tasks = useCore((s) => s.tasks)
  const sources = useCore((s) => s.sources)
  const inboxes = useCore((s) => s.inboxes)
  const inboxOpen = useCore((s) => s.inboxOpen)
  const inboxTabWanted = useCore((s) => s.inboxTab)
  const evolutionSupported = useCore((s) => s.rpc?.features.includes('evolution') ?? false)
  const pluginsSupported = useCore((s) => s.rpc?.features.includes('plugins') ?? false)
  const evolutionStatus = useCore((s) => s.evolutionStatus)
  const filter = useBoardFilter()
  const sort = usePreferences((p) => p.taskSort)
  const abandoned = usePreferences((p) => p.showAbandonedTasks)

  const allTasks = useMemo(() => Object.values(tasks), [tasks, getLocale()])
  const sourceList = sources ?? []
  const activeSourceInboxes = useMemo(() => activeInboxes(sources, inboxes), [sources, inboxes])

  // If opened via legacy setInboxOpen(true), focus the matching active source channel automatically.
  useEffect(() => {
    if (!inboxOpen) return
    const targetProvider = inboxTabWanted?.split('/')[0] ?? activeSourceInboxes[0]?.inbox.provider ?? sourceList[0]?.provider
    if (targetProvider) {
      useBoardFilter.setState({ channel: `source:${targetProvider}` })
    }
    setInboxOpen(false)
  }, [inboxOpen, inboxTabWanted, activeSourceInboxes, sourceList])

  const selectedSourceProvider = filter.channel.startsWith('source:') ? filter.channel.slice('source:'.length) : null
  const selectedSource = selectedSourceProvider
    ? sourceList.find((entry) => entry.provider === selectedSourceProvider) ?? null
    : null

  useEffect(() => {
    if (selectedSourceProvider && sources !== null && !selectedSource) {
      useBoardFilter.setState({ channel: 'all' })
    }
  }, [selectedSourceProvider, sources, selectedSource])

  const channelTasks = useMemo(() => {
    if (filter.channel === 'local') {
      return allTasks.filter((task) => !task.source && !isEvolutionTask(task))
    }
    if (filter.channel === 'evolution') {
      return allTasks.filter((task) => isEvolutionTask(task))
    }
    if (selectedSourceProvider) {
      return allTasks.filter((task) => task.source?.provider === selectedSourceProvider)
    }
    return allTasks
  }, [allTasks, filter.channel, selectedSourceProvider])

  const columns = useMemo(
    () => boardColumns(channelTasks, filter, sort, { abandoned, allDone: filter.allDone }),
    [channelTasks, filter, sort, abandoned, getLocale()]
  )

  const [menu, setMenu] = useState<{ id: string; at: MenuPoint } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const menuTask = menu ? tasks[menu.id] : undefined
  const narrowed = filter.query.trim() !== '' || filter.project !== null || filter.agent !== null
  const now = Date.now()
  const [freshId, setFreshId] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], .xterm, [role="menu"], dialog')) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      if (filter.channel === 'all' || filter.channel === 'local') {
        openQuickAdd()
      } else {
        setNewTaskOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [filter.channel])

  const localCount = useMemo(
    () => allTasks.filter((task) => !task.source && !isEvolutionTask(task) && task.status !== 'done' && task.status !== 'abandoned').length,
    [allTasks]
  )
  const openTotalCount = useMemo(
    () => allTasks.filter((task) => task.status !== 'done' && task.status !== 'abandoned').length,
    [allTasks]
  )
  const waitingRemoteEntries = activeSourceInboxes.filter((entry) => entry.inbox.items.length > 0)
  const totalRemoteWaiting = waitingRemoteEntries.reduce((sum, entry) => sum + entry.inbox.items.length, 0)

  const renderTrackedItems = (allowQuickAdd: boolean) =>
    filter.viewMode === 'list' ? (
      <div className="agenda-list-view">
        {allowQuickAdd && (
          <div className="agenda-list-quick-add">
            <TaskQuickAdd onCreated={setFreshId} />
          </div>
        )}
        {columns.map((column) => (
          <ListGroup key={column.status} column={column} narrowed={narrowed}>
            {column.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                tasks={tasks}
                now={now}
                fresh={freshId === task.id}
                renaming={renamingId === task.id}
                menuOpen={menu?.id === task.id}
                onRenamed={() => setRenamingId(null)}
                onMenu={(at) => setMenu({ id: task.id, at })}
              />
            ))}
          </ListGroup>
        ))}
      </div>
    ) : (
      <TaskDependencies columns={columns}>
        <div className="task-board-columns">
          {columns.map((column) => (
            <Column
              key={column.status}
              column={column}
              narrowed={narrowed}
              top={allowQuickAdd && column.status === 'pending' && <TaskQuickAdd onCreated={setFreshId} />}
            >
              {column.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  tasks={tasks}
                  now={now}
                  fresh={freshId === task.id}
                  renaming={renamingId === task.id}
                  menuOpen={menu?.id === task.id}
                  onRenamed={() => setRenamingId(null)}
                  onMenu={(at) => setMenu({ id: task.id, at })}
                />
              ))}
            </Column>
          ))}
        </div>
      </TaskDependencies>
    )

  return (
    <section className="task-board" aria-label={t('GitInspector.task')}>
      <header className="task-board-header">
        <h2>{t('TaskBoard.runs')}</h2>
        <input
          className="input task-board-search"
          type="search"
          aria-label={t('DependencyPicker.searchTasks')}
          placeholder={t('TaskBoard.titleSourceKeyOrTaskId')}
          value={filter.query}
          onChange={(event) => useBoardFilter.setState({ query: event.target.value })}
        />
        <ProjectFilter tasks={channelTasks} value={filter.project} />
        <AgentFilter tasks={channelTasks} value={filter.agent} />
        <span className="task-board-spacer" />
        <div className="agenda-view-switch" role="group" aria-label={t('Agenda.viewMode')}>
          <button
            type="button"
            className="agenda-view-btn"
            aria-pressed={filter.viewMode === 'board'}
            onClick={() => useBoardFilter.setState({ viewMode: 'board' })}
          >
            {t('Agenda.viewBoard')}
          </button>
          <button
            type="button"
            className="agenda-view-btn"
            aria-pressed={filter.viewMode === 'list'}
            onClick={() => useBoardFilter.setState({ viewMode: 'list' })}
          >
            {t('Agenda.viewList')}
          </button>
        </div>
        <button
          type="button"
          className="task-board-chip"
          aria-pressed={abandoned}
          onClick={() => setPreference('showAbandonedTasks', !abandoned)}
        >
          {t('ChatRequestCards.cancelled')}
        </button>
        <SortButton value={sort} />
        <button type="button" className="button primary task-board-new" onClick={() => setNewTaskOpen(true)}>
          {tr('TaskBoard.newTask', { value1: <span className="task-board-key">{TASK_SHORTCUT_LABEL}</span> })}
        </button>
      </header>

      <nav className="agenda-channel-bar" aria-label={t('Agenda.channels')}>
        <button
          type="button"
          className="agenda-channel-tab"
          aria-pressed={filter.channel === 'all'}
          onClick={() => useBoardFilter.setState({ channel: 'all' })}
        >
          <span>{t('Agenda.all')}</span>
          {openTotalCount > 0 && <span className="agenda-channel-count">{openTotalCount}</span>}
        </button>

        <button
          type="button"
          className="agenda-channel-tab"
          aria-pressed={filter.channel === 'local'}
          onClick={() => useBoardFilter.setState({ channel: 'local' })}
        >
          <span>{t('Agenda.local')}</span>
          {localCount > 0 && <span className="agenda-channel-count">{localCount}</span>}
        </button>

        {sourceList.map((source) => {
          const box = inboxes[inboxKey({ provider: source.provider, instance: DEFAULT_INSTANCE })]
          const connected = Boolean(box?.active)
          const failed = Boolean(box?.problem)
          const remoteCount = box?.items.length ?? 0
          const trackedActiveCount = allTasks.filter(
            (task) => task.source?.provider === source.provider && task.status !== 'done' && task.status !== 'abandoned'
          ).length
          const badgeCount = remoteCount + trackedActiveCount
          const tabKey: AgendaChannel = `source:${source.provider}`
          return (
            <button
              key={source.provider}
              type="button"
              className="agenda-channel-tab"
              aria-pressed={filter.channel === tabKey}
              onClick={() => useBoardFilter.setState({ channel: tabKey })}
            >
              <span
                className="agenda-channel-dot"
                data-connected={connected || undefined}
                data-error={failed || undefined}
                aria-hidden="true"
              />
              <span>{source.name}</span>
              {badgeCount > 0 && <span className="agenda-channel-count">{badgeCount}</span>}
            </button>
          )
        })}

        {evolutionSupported && (
          <button
            type="button"
            className="agenda-channel-tab"
            aria-pressed={filter.channel === 'evolution'}
            onClick={() => useBoardFilter.setState({ channel: 'evolution' })}
          >
            {evolutionStatus?.activeGeneration?.state === 'running' && <Spinner />}
            <span>{t('EvolutionDialog.entry')}</span>
            {(evolutionStatus?.openFrictionCount ?? 0) > 0 && (
              <span className="agenda-channel-count">{evolutionStatus?.openFrictionCount}</span>
            )}
          </button>
        )}

        {pluginsSupported && (
          <button
            type="button"
            className="agenda-channel-more"
            data-tooltip={t('Agenda.addChannelHint')}
            onClick={() => setSettingsOpen(true, 'plugins')}
          >
            {t('Agenda.addChannel')}
          </button>
        )}
      </nav>

      {filter.channel === 'all' && totalRemoteWaiting > 0 && (
        <div className="agenda-remote-banner" role="region" aria-label={t('Agenda.channels')}>
          <span className="muted">{t('Agenda.remoteBanner', { value1: totalRemoteWaiting })}</span>
          <div className="agenda-remote-banner-pills">
            {waitingRemoteEntries.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="task-board-chip"
                onClick={() => useBoardFilter.setState({ channel: `source:${entry.inbox.provider}` })}
              >
                <span>{entry.name}</span>
                <span className="agenda-channel-count">{entry.inbox.items.length}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {filter.channel === 'all' && activeSourceInboxes.length === 0 && sourceList.length > 0 && (
        <div className="agenda-remote-banner" role="region" aria-label={t('Agenda.channels')}>
          <span className="muted">{t('Agenda.quickConnectHint')}</span>
          <div className="agenda-remote-banner-pills">
            {sourceList.map((source) => (
              <button
                key={source.provider}
                type="button"
                className="task-board-chip"
                onClick={() => useBoardFilter.setState({ channel: `source:${source.provider}` })}
              >
                {t('Agenda.quickConnectAction', { value1: source.name })}
              </button>
            ))}
          </div>
        </div>
      )}

      {filter.channel === 'evolution' ? (
        <div className="agenda-evolution-page">
          <EvolutionPanel />
          {channelTasks.length > 0 && (
            <section className="agenda-tracked-section">
              <h3 className="agenda-section-heading">{t('Agenda.importedBoard', { value1: channelTasks.length })}</h3>
              {renderTrackedItems(false)}
            </section>
          )}
        </div>
      ) : selectedSource ? (
        <AgendaSourceChannel
          source={selectedSource}
          inbox={inboxes[inboxKey({ provider: selectedSource.provider, instance: DEFAULT_INSTANCE })]}
          query={filter.query}
          trackedCount={channelTasks.length}
          trackedContent={renderTrackedItems(false)}
        />
      ) : (
        renderTrackedItems(true)
      )}

      {menu && menuTask && (
        <TaskContextMenu task={menuTask} at={menu.at} onClose={closeMenu} onRename={() => setRenamingId(menuTask.id)} />
      )}
    </section>
  )
}

function Column({ column, narrowed, top, children }: { column: BoardColumn; narrowed: boolean; top?: ReactNode; children: ReactNode }) {
  const hidden = column.total - column.tasks.length
  return (
    <section className="task-board-column" aria-label={STATUS_LABEL[column.status]} data-status={column.status}>
      <h3 className="task-board-column-title">
        <StatusIcon status={column.status} decorative />
        <span>{STATUS_LABEL[column.status]}</span>
        <span className="count">{column.total}</span>
      </h3>
      {top}
      {column.total === 0 ? !top && <p className="task-board-column-empty">{narrowed ? t('DependencyPicker.noMatchingTasks') : t('TaskBoard.empty')}</p> : children}
      {hidden > 0 && (
        <button type="button" className="task-board-more" onClick={() => useBoardFilter.setState({ allDone: true })}>
          {tr('TaskBoard.showEarlier', { hidden })}
        </button>
      )}
    </section>
  )
}

function ListGroup({ column, narrowed, children }: { column: BoardColumn; narrowed: boolean; children: ReactNode }) {
  if (column.total === 0 && narrowed) return null
  const hidden = column.total - column.tasks.length
  return (
    <section className="agenda-list-group" aria-label={STATUS_LABEL[column.status]} data-status={column.status}>
      <h3 className="task-board-column-title">
        <StatusIcon status={column.status} decorative />
        <span>{STATUS_LABEL[column.status]}</span>
        <span className="count">{column.total}</span>
      </h3>
      {column.total === 0 ? (
        <p className="task-board-column-empty">{t('TaskBoard.empty')}</p>
      ) : (
        <div className="agenda-list-items">{children}</div>
      )}
      {hidden > 0 && (
        <button type="button" className="task-board-more" onClick={() => useBoardFilter.setState({ allDone: true })}>
          {tr('TaskBoard.showEarlier', { hidden })}
        </button>
      )}
    </section>
  )
}

function TaskCard({ task, tasks, now, fresh, renaming, menuOpen, onRenamed, onMenu }: {
  task: Task
  tasks: Readonly<Record<string, Task>>
  now: number
  fresh: boolean
  renaming: boolean
  menuOpen: boolean
  onRenamed: () => void
  onMenu: (at: MenuPoint) => void
}) {
  const turn = useChatTurn(task)
  const activity = useTaskActivity(task)
  const dependencies = task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined)
  const action = cardAction(task, dependencies, turn)
  const planning = task.status === 'pending' && task.conversationId !== null
  const agent = task.agent ? agentLabel(task.agent) : 'Agent'
  return (
    <article
      className="task-card"
      data-task-id={task.id}
      data-menu-open={menuOpen || undefined}
      data-fresh={fresh || undefined}
      data-abandoned={task.status === 'abandoned' || undefined}
      onClick={(event) => {
        if (!renaming && !(event.target instanceof Element && event.target.closest('.task-card-action'))) selectTask(task.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(menuPoint(event))
      }}
    >
      {renaming ? (
        <TitleEditor title={task.title} label={t('NewTaskDialog.taskTitle')} onSave={(title) => saveTaskText(task.id, 'title', title)} onDone={onRenamed} />
      ) : (
        <button type="button" className="task-card-title" title={task.title}>
          {task.title}
          {dependencies.length > 0 && (
            <span className="visually-hidden">
              {t('TaskBoard.dependencies', { titles: dependencies.map((dependency) => dependency.title).join(getLocale() === 'en' ? ', ' : '、') })}
            </span>
          )}
        </button>
      )}
      {(planning || task.source || waitingOn(task, tasks) > 0 || (task.status === 'pending' && task.repos.length === 0)) && (
        <span className="task-card-tags">
          {task.source && <span className="task-tag mono">{`${task.source.name} · ${task.source.key}`}</span>}
          {task.status === 'pending' && task.repos.length === 0 && <span className="task-tag">{t('TaskBoard.needsProject')}</span>}
          {planning && <span className="task-tag task-tag-refining">{task.plan && !task.plan.approved ? t('TaskBoard.planSaved') : t('TaskBoard.planning')}</span>}
          {waitingOn(task, tasks) > 0 && <span className="task-tag">{t('TaskBoard.waitingForDependencies')}</span>}
        </span>
      )}
      <TaskAlerts task={task} />
      {activity && <TaskActivity activity={activity} />}
      <span className="task-card-meta">
        <span className="task-card-agent" title={agent}><AgentIcon agent={task.agent} /></span>
        <span className="task-card-project">{projectNames(task.repos.map((repo) => repo.path))}</span>
        <span className="task-card-time">{timeAgo(task.updatedAt, now)}</span>
      </span>
      {action && (
        <span className="task-card-action">
          <button
            type="button"
            className="button"
            aria-disabled={action.reason !== null}
            data-tooltip={action.reason ? t('TaskBoard.cannotYet', { value1: action.label, value2: action.reason }) : undefined}
            onClick={() => {
              if (!action.reason) action.run()
            }}
          >
            {action.label}
          </button>
        </span>
      )}
    </article>
  )
}

function ProjectFilter({ tasks, value }: { tasks: readonly Task[]; value: string | null }) {
  const projects = useMemo(() => boardProjects(tasks), [tasks, getLocale()])
  if (projects.length < 2 && value === null) return null
  return (
    <ChatPicker
      label={t('TaskBoard.filterByProject')}
      value={value ?? ''}
      placeholder={t('TaskBoard.allProjects')}
      options={[{ value: '', label: t('TaskBoard.allProjects') }, ...projects.map((project) => ({ value: project, label: projectName(project), description: project }))]}
      size="large"
      placement="below"
      onChange={(project) => useBoardFilter.setState({ project: project || null })}
    />
  )
}

function AgentFilter({ tasks, value }: { tasks: readonly Task[]; value: AgentKind | null }) {
  const used = AGENT_KINDS.filter((agent) => tasks.some((task) => task.agent === agent))
  if (used.length < 2 && value === null) return null
  return (
    <ChatPicker
      label={t('TaskBoard.filterByAgent')}
      value={value ?? ''}
      placeholder={t('TaskBoard.allAgents')}
      options={[{ value: '', label: t('TaskBoard.allAgents') }, ...used.map((agent) => ({ value: agent, label: agentLabel(agent), icon: <AgentIcon agent={agent} /> }))]}
      size="large"
      placement="below"
      onChange={(picked) => useBoardFilter.setState({ agent: AGENT_KINDS.find((agent) => agent === picked) ?? null })}
    />
  )
}

function SortButton({ value }: { value: TaskSort }) {
  return (
    <ChatPicker
      label={t('ConversationList.sortBy')}
      value={value}
      placeholder={SORT_LABEL[value]}
      options={TASK_SORTS.map((sort) => ({ value: sort, label: SORT_LABEL[sort] }))}
      size="large"
      placement="below"
      align="end"
      onChange={(picked) => {
        const sort = TASK_SORTS.find((each) => each === picked)
        if (sort) setPreference('taskSort', sort)
      }}
    />
  )
}
