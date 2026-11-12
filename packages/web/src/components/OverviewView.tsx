import { getLocale, localized, t, tr } from '../i18n'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatDecision } from '@conclave/protocol'
import { quickApproval, type ActionableItem } from '../attention'
import {
  openAttentionItem, perform, refreshAttentionSummaries, selectConversation, selectTask,
  setOverviewFilter, setOverviewScroll, setOverviewView, setRoutinesOpen,
  setSchedulesOpen, setSettingsOpen, showView, useDashboardSupported, useOverview, useCore, type OverviewFilter
} from '../core-store'
import { DashboardPanel } from './DashboardPanel'
import { Segmented } from './SettingsControls'
import { agentLabel, agoText, chatDayAndTime, timeOfDay } from '../labels'
import { laterByDay, waitBreakdown, type OverviewRow } from '../overview'
import { markRoutineAllSeen, runRoutineNow } from '../routines'
import { rescheduleRun, runScheduleNow, scheduleTime } from '../schedules'
import { primaryProjectName } from './ProjectPicker'
import { conversationActivity, taskActivity, type WorkActivity } from '../work-activity'
import { SchedulePicker } from './SchedulePicker'
import { WorkingSummary } from './WorkingSummary'
import { AgentIcon, BoardIcon, ChatIcon, ClockIcon, RefreshIcon, SquadIcon } from './icons'
import { ResumableSessionList, resumableSummary } from './ResumableSessions'
import { canResume, resumableSessions } from '../resumable-sessions'
import { useExternalSessionsWhen } from '../external-sessions'
import { usePreferences } from '../preferences'
import { useProviderProbes } from '../provider-probes'

const KIND_ICON = { task: BoardIcon, conversation: ChatIcon, squad: SquadIcon, routine: RefreshIcon, schedule: ClockIcon }
const KIND_LABEL = localized(() => ({ task: t('GitInspector.task'), conversation: t('BrowserPanel.conversation'), squad: t('NewTaskDialog.developmentSquad'), routine: t('OverviewView.routines'), schedule: t('OverviewView.schedules') }))

function openRow(row: OverviewRow): void {
  if (row.attention) return openAttentionItem(row.attention)
  const state = useCore.getState()
  const run = state.schedules.find((run) => run.id === row.scheduleId)
  const taskId = row.kind === 'task' || row.kind === 'squad' ? row.key.slice('task:'.length)
    : run?.target.kind === 'task' ? run.target.taskId : undefined
  if (taskId && state.tasks[taskId]) {
    selectTask(taskId)
    if (row.conversationId) {
      showView('chat')
    }
  } else if (row.conversationId && state.conversations[row.conversationId]) {
    selectConversation(row.conversationId)
  } else if (row.routineId) setRoutinesOpen(true, 'routines')
  else if (row.scheduleId) setSchedulesOpen(true)
}

function markSeen(row: OverviewRow): void {
  if (row.routineId) {
    markRoutineAllSeen(row.routineId)
    return
  }
  useCore.setState((state) => {
    const ids = new Set([row.conversationId])
    if (row.kind === 'task' || row.kind === 'squad') {
      const taskId = row.key.slice('task:'.length)
      ids.add(state.tasks[taskId]?.conversationId ?? undefined)
      for (const conversation of Object.values(state.conversations)) {
        if (conversation.taskId === taskId) ids.add(conversation.id)
      }
    }
    return { unseen: Object.fromEntries(Object.entries(state.unseen).filter(([id]) => !ids.has(id))) }
  })
}

function GoTo({ item, ghost = false }: { item: ActionableItem; ghost?: boolean }) {
  return <button type="button" className={ghost ? 'button ghost' : 'button'} aria-label={t('OverviewView.respond', { value1: item.title })} onClick={() => openAttentionItem(item)}>{t('DiscussionView.respond')}</button>
}

// An approval that can be answered here gets its answers, and the chat only on hover.
function ApprovalActions({ item }: { item: ActionableItem }) {
  const [busy, setBusy] = useState(false)
  const { request, conversationId } = item
  const quick = conversationId && quickApproval(request) ? request : null
  const answer = async (decision: ChatDecision) => {
    if (!quick || !conversationId || busy) return
    setBusy(true)
    await perform((rpc) => rpc.call('conversations.respond', { id: conversationId, requestId: quick.requestId, decision }))
    setBusy(false)
  }
  if (!quick) return <GoTo item={item} />
  return (
    <>
      <span className="overview-secondary"><GoTo item={item} ghost /></span>
      <button type="button" className="button" disabled={busy} aria-label={t('OverviewView.deny', { value1: quick.title })} onClick={() => void answer('deny')}>{t('approvalChoiceText.deny')}</button>
      <button type="button" className="button primary" disabled={busy} aria-label={t('OverviewView.allowOnce', { value1: quick.title })}
        data-tooltip={t('OverviewView.allowThisTimeOnlyWithoutSavingARule')} onClick={() => void answer('allow')}>{t('approvalChoiceText.allow')}</button>
    </>
  )
}

function Reschedule({ id }: { id: string }) {
  const run = useCore((s) => s.schedules.find((run) => run.id === id))
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  if (!run || run.target.kind === 'resume') return null
  return (
    <span className="menu-anchor">
      <button type="button" className="button ghost" aria-label={t('OverviewView.reschedule_1284', { value1: run.title })} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>{t('OverviewView.reschedule')}</button>
      {open && <SchedulePicker title={t('OverviewView.changeScheduledTime')} initial={run.notBefore} submitLabel={t('FileEditor.save')} align="end"
        onSchedule={async (notBefore) => (await rescheduleRun(id, notBefore)) !== null} onClose={close} />}
    </span>
  )
}

function rowTaskId(row: OverviewRow): string | null {
  return row.kind === 'task' || row.kind === 'squad' ? row.key.slice('task:'.length) : null
}

// Who is at work on a running row, said as on the board.
function useRowActivity(row: OverviewRow): WorkActivity | null {
  const taskId = rowTaskId(row)
  const task = useCore((s) => (taskId ? s.tasks[taskId] : undefined))
  const conversation = useCore((s) => (row.conversationId ? s.conversations[row.conversationId] : undefined))
  const conversations = useCore((s) => s.conversations)
  return useMemo(() => task ? taskActivity(task, conversations)
    : conversation ? conversationActivity(conversation, conversation.agent) : null, [task, conversation, conversations, getLocale()])
}

function Avatar({ row }: { row: OverviewRow }) {
  const Kind = KIND_ICON[row.kind]
  const label = [KIND_LABEL[row.kind], row.agent ? agentLabel(row.agent) : ''].filter(Boolean).join(' · ')
  return (
    <span className="overview-avatar" role="img" aria-label={label}>
      {row.agent ? <AgentIcon agent={row.agent} /> : <Kind />}
    </span>
  )
}

function useRunNow(row: OverviewRow) {
  const [busy, setBusy] = useState(false)
  const runningNow = useRef(false)
  const runNow = async () => {
    if (runningNow.current || busy) return
    runningNow.current = true
    setBusy(true)
    try {
      if (row.kind === 'schedule' && row.scheduleId) await runScheduleNow(row.scheduleId)
      else if (row.routineId) await runRoutineNow(row.routineId)
    } finally {
      runningNow.current = false
      setBusy(false)
    }
  }
  return { busy, runNow }
}

function Meta({ row, reason = false }: { row: OverviewRow; reason?: boolean }) {
  return (
    <div className="overview-meta">
      <span>{KIND_LABEL[row.kind]}</span>
      {row.projectPaths.length > 0 && <span className="overview-project" title={row.projectPaths.join('\n')}>{primaryProjectName(row.projectPaths)}</span>}
      {reason && row.reason && <span>{row.reason}</span>}
      {row.detail && <span>{row.detail}</span>}
    </div>
  )
}

// A row in a panel: who, what and why on the left, when and what to do on the right; what is
// done less often shows on hover.
function Row({ row, section }: { row: OverviewRow; section: 'mine' | 'running' | 'unread' }) {
  const activity = useRowActivity(row)
  const failure = row.failed
  const opens = section === 'running'
  return (
    <li>
      <div className="overview-row" role={opens ? 'button' : undefined} tabIndex={opens ? 0 : undefined}
        onClick={opens ? () => openRow(row) : undefined}
        onKeyDown={opens ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRow(row) } } : undefined}>
        <Avatar row={row} />
        <div className="overview-row-main">
          <div className="overview-row-title">
            <h4>{row.title}</h4>
            {section === 'mine' && <span className="overview-badge" data-reason={failure ? 'crashed' : row.attention?.primaryReason}>{row.reason}</span>}
          </div>
          <Meta row={row} />
          {section === 'running' && activity && <WorkingSummary activity={activity} />}
          {!!row.members?.length && <details className="overview-members">
            <summary>{tr('OverviewView.findMember', { value1: row.members.length })}</summary>
            <ul>{row.members.map((member) => <li className="overview-member" key={member.conversationId}>
              <span>{member.title}{member.request && ` · ${member.request.title}${member.request.open > 1 ? t('OverviewView.more', { value1: member.request.open - 1 }) : ''}`}</span>
              <span className="overview-actions"><ApprovalActions item={member} /></span>
            </li>)}</ul>
          </details>}
        </div>
        <time className="overview-time" dateTime={new Date(row.at).toISOString()} title={chatDayAndTime(row.at)}>{agoText(row.at)}</time>
        <div className="overview-actions">
          {section === 'mine' && (failure
            ? <button type="button" className="button" aria-label={t('OverviewView.viewFailed', { value1: KIND_LABEL[row.kind], value2: row.title })} onClick={() => row.kind === 'schedule' ? setSchedulesOpen(true) : setRoutinesOpen(true, 'routines')}>{row.kind === 'schedule' ? t('OverviewView.goToSchedules') : t('EnvironmentNotice.view')}</button>
            : row.attention && <ApprovalActions item={row.attention} />)}
          {section === 'unread' && <>
            <span className="overview-secondary"><button type="button" className="button ghost" aria-label={t('OverviewView.markAsRead_1291', { value1: row.title })} onClick={() => markSeen(row)}>{t('OverviewView.markAsRead')}</button></span>
            <button type="button" className="button" aria-label={t('OverviewView.open', { value1: row.title })} onClick={() => openRow(row)}>{t('ChatBrowserCard.open')}</button>
          </>}
        </div>
      </div>
    </li>
  )
}

// Something coming up, at its time on a line, the next of them marked.
function TimelineItem({ row, time, next }: { row: OverviewRow; time: string; next: boolean }) {
  const { busy, runNow } = useRunNow(row)
  const Icon = KIND_ICON[row.kind]
  return (
    <li className="overview-timeline-item" data-next={next ? '' : undefined}>
      <time dateTime={new Date(row.at).toISOString()}>{time}</time>
      <span className="overview-timeline-dot" aria-hidden="true" />
      <div className="overview-row-main">
        <div className="overview-row-title"><span className="overview-kind" role="img" aria-label={KIND_LABEL[row.kind]}><Icon /></span><h4>{row.title}</h4></div>
        <Meta row={row} reason={!time} />
      </div>
      <div className="overview-actions overview-secondary">
        {row.scheduleId && row.kind === 'schedule' && <Reschedule id={row.scheduleId} />}
        {(row.kind === 'schedule' ? row.scheduleId : row.routineId) && <button type="button" className="button ghost" disabled={busy} aria-label={t('OverviewView.runNow_1294', { value1: row.title })} onClick={() => void runNow()}>{t('OverviewView.runNow')}</button>}
      </div>
    </li>
  )
}

function Timeline({ rows, time, next }: { rows: OverviewRow[]; time: (row: OverviewRow) => string; next?: string }) {
  return <ol className="overview-timeline">{rows.map((row) => <TimelineItem key={row.key} row={row} time={time(row)} next={row.key === next} />)}</ol>
}

function Panel({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="overview-panel" aria-label={title}>
      <header><h3>{title}</h3><span className="overview-count">{count}</span></header>
      {children}
    </section>
  )
}

function Rows({ rows, section }: { rows: OverviewRow[]; section: 'mine' | 'running' | 'unread' }) {
  return <ul className="overview-rows">{rows.map((row) => <Row key={row.key} row={row} section={section} />)}</ul>
}

// Before there is any work here, the work already under way in a terminal, to go on with. Not while
// the setup guide offers the same.
function ResumablePanel() {
  const blank = useCore((s) => Object.keys(s.tasks).length === 0 && Object.keys(s.conversations).length === 0)
  const environment = useCore((s) => s.environment)
  const providers = useCore((s) => s.modelProviders)
  const disabled = usePreferences((s) => s.disabledAgents)
  const guiding = usePreferences((s) => s.setup.status === 'active' && s.setup.sessionChoice === 'pending')
  const probes = useProviderProbes((s) => s.probes)
  const sessions = useExternalSessionsWhen(blank)
  if (!blank || guiding || !sessions) return null
  const { count, agents, shown } = resumableSessions(sessions, (agent) => canResume(agent, environment, disabled, providers, probes))
  if (!shown.length) return null
  return (
    <Panel title={t('ResumableSessions.title')} count={count}>
      <p className="resumable-note">{resumableSummary(count, agents)}</p>
      <ResumableSessionList sessions={shown} />
      {count > shown.length && <div className="resumable-more">
        <button type="button" className="link-button" onClick={() => setSettingsOpen(true, 'session-import')}>{t('ResumableSessions.viewAll')}</button>
      </div>}
    </Panel>
  )
}

const WEEKDAY = localized(() => [t('ActivityHeatmap.sun'), t('ActivityHeatmap.mon'), t('routines.tue'), t('ActivityHeatmap.wed'), t('routines.thu'), t('ActivityHeatmap.fri'), t('routines.sat')])
const PANES = localized(() => ([{ value: 'now', label: t('OverviewView.now') }, { value: 'stats', label: t('OverviewView.statistics') }] as const))

export function OverviewView() {
  const data = useOverview()
  const [laterOpen, setLaterOpen] = useState(false)
  const filter = useCore((s) => s.overviewFilter)
  // The stats are the overview's other side, where core keeps them.
  const statsSupported = useDashboardSupported()
  const chosenPane = useCore((s) => s.overviewView)
  const pane = statsSupported ? chosenPane : 'now'
  const connected = useCore((s) => s.connection === 'connected')
  const loading = useCore((s) => s.attentionSummaryLoading)
  const mode = useCore((s) => s.attentionSummaryMode)
  const error = useCore((s) => s.attentionSummaryError)
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const page = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (page.current) page.current.scrollTop = useCore.getState().overviewScroll
  }, [])
  const now = Date.now()
  // Everyone at work across the running rows, for the head.
  const working = useMemo(() => data.running.flatMap((row) => {
    const taskId = rowTaskId(row)
    const task = taskId ? tasks[taskId] : undefined
    const conversation = row.conversationId ? conversations[row.conversationId] : undefined
    const activity = task ? taskActivity(task, conversations) : conversation ? conversationActivity(conversation, conversation.agent) : null
    return activity?.workers ?? []
  }), [data.running, tasks, conversations, getLocale()])
  const counts = data.counts
  const ranges = [
    { value: 'mine', label: t('OverviewView.waitingOnMe') },
    { value: 'running', label: t('OverviewView.running') }, { value: 'next', label: t('OverviewView.upNext') }, { value: 'unread', label: t('OverviewView.unread') }
  ] as const
  const emptyConfirmed = connected && !loading && !error && mode !== null
  const empty = Object.values(counts).every((count) => count === 0)
  const shows = (range: Exclude<OverviewFilter, null>) => (!filter || filter === range) && counts[range] > 0
  const nextUp = data.next.byTime[0] ?? data.next.later[0]
  const latestUnread = data.unread.at(-1)
  const foot: Record<Exclude<OverviewFilter, null>, ReactNode> = {
    mine: data.counts.mine > 0 ? waitBreakdown(data.mine) : t('OverviewView.nothingWaitingOnYou'),
    running: working.length > 0
      ? <WorkingSummary activity={{ state: 'running', workers: working, detail: null }} detail={false} />
      : data.counts.running > 0 ? t('OverviewView.starting') : t('OverviewView.nothingRunning'),
    next: nextUp ? t('OverviewView.next', { value1: scheduleTime(nextUp.at, now) }) : data.next.byCondition.length > 0 ? t('OverviewView.waitingForConditions', { value1: data.next.byCondition.length }) : t('OverviewView.nothingScheduled'),
    unread: latestUnread ? t('OverviewView.latest', { value1: agoText(latestUnread.at, now) }) : t('OverviewView.allRead')
  }
  const mine = shows('mine') && <Panel title={t('OverviewView.needsMe')} count={data.counts.mine}><Rows rows={data.mine} section="mine" /></Panel>
  const unread = shows('unread') && <Panel title={t('OverviewView.unread')} count={data.counts.unread}><Rows rows={data.unread} section="unread" /></Panel>
  const running = shows('running') && <Panel title={t('ChatTodos.inProgress')} count={data.counts.running}><Rows rows={data.running} section="running" /></Panel>
  const next = shows('next') && <Panel title={t('OverviewView.upNext')} count={data.counts.next}>
    {data.next.byTime.length > 0 && <><h4 className="overview-day">{t('OverviewView.today')}</h4><Timeline rows={data.next.byTime} time={(row) => timeOfDay(row.at)} next={nextUp?.key} /></>}
    {data.next.later.length > 0 && <>
      <button type="button" className="overview-day overview-disclosure" aria-expanded={laterOpen} onClick={() => setLaterOpen(!laterOpen)}>{tr('OverviewView.itemsTomorrowOrLater', { value1: data.next.later.length })}</button>
      {laterOpen && laterByDay(data.next.later, now).map(({ day, rows }) => <div key={day}>
        <h4 className="overview-day">{day}</h4>
        <Timeline rows={rows} time={(row) => timeOfDay(row.at)} next={nextUp?.key} />
      </div>)}
    </>}
    {data.next.byCondition.length > 0 && <><h4 className="overview-day">{t('OverviewView.waitingForConditions_1328')}</h4><Timeline rows={data.next.byCondition} time={() => ''} /></>}
  </Panel>
  const today = new Date(now)
  return (
    <section ref={page} className="worktrees-page overview-page" aria-label={t('OverviewEntry.overview_1276')} onScroll={(event) => setOverviewScroll(event.currentTarget.scrollTop)}>
      <header className="worktrees-header">
        <div className="worktrees-heading">
          <h2>{t('OverviewEntry.overview_1276')}</h2>
          <p className="muted">{tr('OverviewView.todayDate', { value1: today.getMonth() + 1, value2: today.getDate(), value3: WEEKDAY[today.getDay()] })}</p>
        </div>
        {statsSupported && <>
          <Segmented labelId="overview-pane" value={pane} options={PANES} onChange={(next) => {
            setOverviewView(next)
            if (page.current) page.current.scrollTop = 0
          }} />
          <span id="overview-pane" hidden>{t('OverviewView.overviewContent')}</span>
        </>}
      </header>
      {pane === 'stats' ? <DashboardPanel /> : <>
      {!connected && <p className="attention-notice muted" role="status">{tr('OverviewView.notConnectedToCoreItemsAreNotUp', { value1: !empty ? t('OverviewView.showingTheLatestReceivedInformation') : t('OverviewView.workOverviewAppearsAfterConnecting') })}</p>}
      {connected && loading && <p className="attention-notice muted" role="status">{t('OverviewView.loadingPendingItems')}</p>}
      {mode === 'limited' && <p className="attention-notice muted">{t('OverviewView.currentCoreProvidesIncompleteTaskChatDetails')}</p>}
      {error && <div className="attention-notice attention-error" role="alert">
        <div>{tr('OverviewView.chatSummariesFailedToLoadItemsMayBe', { value1: <span className="muted">{error}</span> })}</div>
        <button type="button" className="button ghost" disabled={!connected || loading} onClick={() => void refreshAttentionSummaries()}>{t('ChatContextMenu.retry')}</button>
      </div>}
      <div className="overview-kpis" role="group" aria-label={t('OverviewView.workScope')} data-count={ranges.length}>
        {ranges.map(({ value, label }) => <button type="button" key={value} className="overview-kpi" aria-pressed={filter === value}
          aria-label={`${label} ${counts[value]}`} data-waiting={value === 'mine' && data.counts.mine > 0 ? '' : undefined}
          onClick={() => {
            setOverviewFilter(filter === value ? null : value)
            if (page.current) page.current.scrollTop = 0
          }}>
          <span className="overview-kpi-label">{label}</span>
          <span className="overview-kpi-value">{counts[value]}</span>
          <span className="overview-kpi-foot">{foot[value]}</span>
        </button>)}
      </div>
      {/* What the user acts on to the left, what they only follow to the right; one column when
          only one side has anything, or when the pane is narrow. */}
      <div className="overview-grid" data-columns={(mine || unread) && (running || next) ? 2 : 1}>
        {(mine || unread) && <div className="overview-column">{mine}{unread}</div>}
        {(running || next) && <div className="overview-column">{running}{next}</div>}
      </div>
      {empty && emptyConfirmed && <>
        <ResumablePanel />
        <p className="attention-empty muted">{t('OverviewView.noWorkInProgress')}</p>
      </>}
      </>}
    </section>
  )
}
