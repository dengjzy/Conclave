import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ConversationStage, Task } from '@conclave/protocol'
import { loadConversation, selectTask, showView, useCore } from '../core-store'
import { agentLabel, dayAndTime } from '../labels'
import { t } from '../i18n'
import { setPreference, usePreferences } from '../preferences'
import { followWorkflowLane } from '../workflow-progress'
import { workflowLanes, type WorkflowLane } from '../workflow-lanes'
import { activeWorkflowEvent, latestWorkflowEvent, workflowEvents, type WorkflowEvent } from '../workflow-events'
import { retainChat } from '../chat-watch'
import { prependChatPage, useChat } from '../chat-state'
import { requestStageJump } from '../chat-stage-jump'
import { AgentIcon } from './icons'
import { WorkflowRequest } from './WorkflowRequest'

const PHASE_LABEL = {
  pending: 'WorkflowProcess.pending', starting: 'WorkflowProcess.starting', running: 'WorkflowProcess.running', awaiting: 'WorkflowProcess.awaiting',
  idle: 'WorkflowProcess.idle', review: 'WorkflowProcess.review', done: 'WorkflowProcess.done', abandoned: 'WorkflowProcess.abandoned', failed: 'WorkflowProcess.failed',
  ended: 'WorkflowProcess.ended', recorded: 'WorkflowProcess.recorded'
} as const
const KIND_LABEL = { stage: 'WorkflowStudio.session', handoff: 'WorkflowStudio.handoff', file: 'WorkflowStudio.file', command: 'WorkflowStudio.command', message: 'WorkflowStudio.message', question: 'WorkflowProcess.awaiting', error: 'WorkflowProcess.failed', checkpoint: 'WorkflowStudio.checkpoint', current: 'WorkflowStudio.current' } as const
const SYMBOL = { stage: '○', handoff: '◆', file: '□', command: '›', message: '·', question: '?', error: '×', checkpoint: '✓', current: '●' } as const
const visibleTreeEvents = (events: readonly WorkflowEvent[]) => events.filter((event) => event.kind !== 'message')
const laneStyle = (index: number): CSSProperties & { '--lane-color': string } => ({ '--lane-color': `var(--graph-${index % 6 + 1})` })

function useWorkflowRecords(lanes: readonly WorkflowLane[]) {
  const rpc = useCore((s) => s.rpc)
  const conversations = useCore((s) => s.conversations)
  const [records, setRecords] = useState<Record<string, ConversationStage[]>>({})
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const ids = [...new Set(lanes.flatMap((lane) => lane.conversationId ? [lane.conversationId] : []))].sort().join(',')
  const sessions = lanes.map((lane) => `${lane.conversationId}:${lane.conversationId ? conversations[lane.conversationId]?.sessionId : ''}`).join('|')
  useEffect(() => {
    if (!rpc) return
    const releases = ids ? ids.split(',').map((id) => {
      if (!useCore.getState().conversations[id]) void loadConversation(id)
      return retainChat(rpc, id)
    }) : []
    return () => releases.forEach((release) => release())
  }, [rpc, ids, retry])
  useEffect(() => {
    if (!rpc || !ids) return
    let current = true
    setFailed(false)
    void Promise.allSettled(ids.split(',').map(async (id) => [id, await rpc.call('conversations.stages', { id })] as const)).then((results) => {
      if (!current) return
      setFailed(results.some((result) => result.status === 'rejected'))
      setRecords(Object.fromEntries(results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])))
    }, () => { if (current) setFailed(true) })
    return () => { current = false }
  }, [rpc, ids, sessions, retry])
  return { records, failed, retry: () => setRetry((value) => value + 1) }
}

export function WorkflowProcess({ tasks, lanes: providedLanes, compact = false, renderTask, autoFocusTaskId }: {
  tasks: readonly Task[]
  lanes?: readonly WorkflowLane[]
  compact?: boolean
  renderTask?: (task: Task) => ReactNode
  autoFocusTaskId?: string | null
}) {
  const conversations = useCore((s) => s.conversations)
  const connected = useCore((s) => s.connection === 'connected')
  const runs = useCore((s) => s.squadRuns)
  const starting = useCore((s) => s.startingTasks)
  const rpc = useCore((s) => s.rpc)
  const pages = useChat()
  const follow = usePreferences((s) => s.workflowFollow)
  const lanes = providedLanes ?? workflowLanes(tasks, conversations, starting, runs)
  const { records, failed, retry } = useWorkflowRecords(lanes)
  const [filter, setFilter] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [followed, setFollowed] = useState<string | null>(null)
  const [limit, setLimit] = useState(200)
  const [loading, setLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [mobileTree, setMobileTree] = useState(false)
  const [treeHeight, setTreeHeight] = useState(400)
  const [treeWidth, setTreeWidth] = useState(384)
  const root = useRef<HTMLElement>(null)
  const summaries = useRef<HTMLDivElement>(null)
  const feed = useRef<HTMLDivElement>(null)
  const camera = useRef<HTMLDivElement>(null)
  const [curve, setCurve] = useState('')
  const events = useMemo(() => lanes.flatMap((lane) => {
    const conversation = lane.conversationId ? conversations[lane.conversationId] : undefined
    const list = workflowEvents({ id: lane.id, agent: lane.agent }, lane.conversationId ? records[lane.conversationId] ?? [] : [], lane.conversationId ? pages[lane.conversationId]?.items ?? [] : [], conversation)
    const stage = lane.conversationId ? records[lane.conversationId]?.findLast((entry) => entry.sessionId === conversation?.sessionId) : undefined
    list.push({ key: `${lane.id}/current`, laneId: lane.id, taskId: lane.taskId, stageId: stage?.id ?? null, at: Math.max(lane.updatedAt, list.at(-1)?.at ?? 0) + 1, agent: lane.agent, kind: 'current', title: t(PHASE_LABEL[lane.phase]), detail: lane.detail ?? '', phase: lane.phase })
    return list
  }).sort((a, b) => a.at - b.at || a.key.localeCompare(b.key)), [lanes, conversations, pages, records])
  const lastActivity = new Map<string, number>()
  for (const event of events) if (event.kind !== 'current') lastActivity.set(event.laneId, event.at)
  const next = connected ? followWorkflowLane(lanes.map((lane) => ({ id: lane.id, phase: lane.phase, updatedAt: Math.max(lane.updatedAt, lastActivity.get(lane.id) ?? 0) })), followed) : null
  useEffect(() => { if (follow) setFollowed(next) }, [follow, next])
  const active = activeWorkflowEvent(events, followed)
  const activeKey = active?.key
  const followState = !follow ? 'off' : browsing ? 'paused' : connected && activeKey ? 'active' : 'idle'
  useEffect(() => {
    if (!follow || browsing || !connected || !activeKey) return
    setSelected(activeKey)
    setFilter(compact ? followed : null)
  }, [follow, browsing, connected, activeKey, followed, compact])
  const focusedLane = autoFocusTaskId ? lanes.find((lane) => lane.taskId === autoFocusTaskId)?.id ?? null : null
  useEffect(() => {
    if (!focusedLane) return
    setBrowsing(false)
    // While following, the working lane owns the camera; opening a task must not pull it back.
    if (follow && active) return
    setFilter(focusedLane)
    const latest = latestWorkflowEvent(events, focusedLane)
    if (latest) setSelected(latest.key)
  }, [focusedLane])
  const selectedEvent = events.find((event) => event.key === selected)
  const treeEvents = visibleTreeEvents(events.slice(-limit))
  const counts = new Map<string, number>()
  const rows = new Map(treeEvents.map((event) => { const row = counts.get(event.laneId) ?? 0; counts.set(event.laneId, row + 1); return [event.key, row] }))
  const rowCount = Math.max(1, ...counts.values())
  const columnWidth = Math.max(84, treeWidth / Math.max(1, lanes.length))
  const step = 28
  const selectedLane = lanes.find((lane) => lane.id === (filter ?? selectedEvent?.laneId))
  const selectedTask = tasks.find((task) => task.id === selectedLane?.taskId)
  const visible = events.slice(-limit)
  const shown = filter ? visible.filter((event) => event.laneId === filter) : visible

  const drawCurve = useCallback(() => {
    if (compact || !root.current || !selected) { setCurve(''); return }
    const from = root.current.querySelector<HTMLElement>(`[data-event-row="${CSS.escape(selected)}"] .wf-request legend`) ?? root.current.querySelector<HTMLElement>(`[data-event-row="${CSS.escape(selected)}"] .wf-event-heading`)
    const to = root.current.querySelector<HTMLElement>(`[data-tree-event="${CSS.escape(selected)}"] .wf-node-mark`)
    const view = feed.current?.getBoundingClientRect()
    const tree = camera.current?.getBoundingClientRect()
    if (!from || !to || !view || !tree) { setCurve(''); return }
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect(), bounds = root.current.getBoundingClientRect()
    if (a.bottom < view.top || a.top > view.bottom || b.bottom < tree.top || b.top > tree.bottom || b.left < tree.left || b.right > tree.right) { setCurve(''); return }
    const x1 = a.right - bounds.left, y1 = a.top + a.height / 2 - bounds.top
    const x2 = b.left + b.width / 2 - bounds.left, y2 = b.top + b.height / 2 - bounds.top
    setCurve(`M ${x1} ${y1} C ${x1 + 64} ${y1}, ${x2 - 80} ${y2}, ${x2} ${y2}`)
  }, [selected, compact])
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const frame = requestAnimationFrame(drawCurve)
    const updateDimensions = () => {
      drawCurve()
      if (camera.current) {
        const h = camera.current.clientHeight
        const w = camera.current.clientWidth
        setTreeHeight((prev) => Math.abs(prev - h) > 1 ? h : prev)
        setTreeWidth((prev) => Math.abs(prev - w) > 1 ? w : prev)
      }
    }
    const resize = new ResizeObserver(updateDimensions)
    resize.observe(element)
    if (camera.current) resize.observe(camera.current)
    return () => { cancelAnimationFrame(frame); resize.disconnect() }
  }, [drawCurve])
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(drawCurve)
    return () => cancelAnimationFrame(frame)
  }, [drawCurve, filter, limit, shown.length])
  useLayoutEffect(() => {
    const row = selected ? root.current?.querySelector<HTMLElement>(`[data-event-row="${CSS.escape(selected)}"]`) : null
    if (!row) return
    const observer = new ResizeObserver(() => drawCurve())
    observer.observe(row)
    return () => observer.disconnect()
  }, [selected, drawCurve, filter, limit])
  useLayoutEffect(() => {
    if (!selected || !root.current) return
    if (!browsing && (!follow || !connected || document.querySelector('dialog[open]') || (document.activeElement instanceof Element && document.activeElement.closest('input:not([type=checkbox]), textarea, select, [contenteditable=true]')))) return
    const motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    const reveal = (view: HTMLDivElement | null, selector: string) => {
      const anchor = root.current?.querySelector<HTMLElement>(selector)
      const node = view === feed.current ? anchor?.querySelector<HTMLElement>('.wf-request') ?? anchor : anchor
      if (!view || !node) return
      const rect = node.getBoundingClientRect(), bounds = view.getBoundingClientRect()
      if (view === camera.current) {
        const topOut = rect.top < bounds.top + 16
        const bottomOut = rect.bottom > bounds.bottom - 16
        const leftOut = rect.left < bounds.left + 12
        const rightOut = rect.right > bounds.right - 16
        const targetTop = bottomOut
          ? Math.min(view.scrollHeight - view.clientHeight, view.scrollTop + (rect.bottom - bounds.bottom) + 24)
          : topOut ? Math.max(0, view.scrollTop + (rect.top - bounds.top) - 24) : view.scrollTop
        const targetLeft = leftOut || rightOut
          ? Math.max(0, view.scrollLeft + (rect.left - bounds.left) - Math.max(0, (bounds.width - rect.width) / 2))
          : view.scrollLeft
        if (Math.abs(targetTop - view.scrollTop) >= 2 || Math.abs(targetLeft - view.scrollLeft) >= 2) {
          view.scrollTo({ top: targetTop, left: targetLeft, behavior: !browsing && follow ? 'instant' : motion })
        }
        return
      }
      const top = rect.top < bounds.top + 24 || rect.bottom > bounds.bottom - 24
      const left = rect.left < bounds.left + 12 || rect.right > bounds.right - 12
      if (top || left) {
        const targetTop = top
          ? node.classList.contains('wf-request')
            ? view.scrollTop + rect.top - bounds.top - view.clientHeight * 0.08
            : !browsing && follow && rect.bottom > bounds.bottom - 24
              ? Math.min(view.scrollHeight - view.clientHeight, view.scrollTop + (rect.bottom - bounds.bottom) + 32)
              : view.scrollTop + rect.top - bounds.top - view.clientHeight * 0.42
          : view.scrollTop
        const targetLeft = left ? view.scrollLeft + rect.left - bounds.left - 20 : view.scrollLeft
        if (Math.abs(targetTop - view.scrollTop) >= 2 || Math.abs(targetLeft - view.scrollLeft) >= 2) {
          view.scrollTo({ top: targetTop, left: targetLeft, behavior: !browsing && follow ? 'instant' : motion })
        }
      }
    }
    reveal(camera.current, `[data-tree-event="${CSS.escape(selected)}"]`)
    reveal(feed.current, `[data-event-row="${CSS.escape(selected)}"]`)
    drawCurve()
  }, [selected, events.length, filter, limit, browsing, follow, connected, drawCurve])
  const choose = (event: WorkflowEvent) => {
    setSelected(event.key)
    setBrowsing(true)
    if (!visible.some((entry) => entry.key === event.key)) setLimit(events.length)
    if (filter && event.laneId !== filter) setFilter(null)
    if (compact) openRecord(event)
  }
  const openRecord = (event: WorkflowEvent) => {
    const lane = lanes.find((entry) => entry.id === event.laneId)
    const task = tasks.find((entry) => entry.id === lane?.taskId)
    if (!lane || !task) return
    selectTask(task.id)
    if (!lane.conversationId) return
    showView('chat')
    if (lane.conversationId !== task.conversationId) {
      useCore.setState({ taskMemberConversationId: lane.conversationId })
    } else {
      useCore.setState({ taskMemberConversationId: null })
    }
    if (event.stageId) requestStageJump(lane.conversationId, event.stageId)
  }
  const older = async () => {
    if (loading) return
    setBrowsing(true)
    if (events.length > limit) { setLimit((value) => value + 200); return }
    if (!rpc) return
    setLoading(true); setHistoryError(false)
    const eligible = lanes.filter((lane) => (!filter || lane.id === filter) && lane.conversationId && pages[lane.conversationId]?.before)
    const results = await Promise.allSettled(eligible.map(async (lane) => {
      const id = lane.conversationId
      if (!id) return
      const before = useChat.getState()[id]?.before
      if (before) prependChatPage(id, await rpc.call('conversations.chatItems', { id, before }))
    }))
    setHistoryError(results.some((result) => result.status === 'rejected'))
    setLimit((value) => value + 200); setLoading(false)
  }
  const hasOlder = events.length > limit || lanes.some((lane) => (!filter || lane.id === filter) && lane.conversationId && pages[lane.conversationId]?.before)
  const laneIndex = Math.max(0, lanes.findIndex((lane) => lane.id === selectedEvent?.laneId))
  const eventTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const resume = () => { setBrowsing(false); setPreference('workflowFollow', true); setFilter(compact ? followed : null); if (activeKey) setSelected(activeKey) }
  return <section ref={root} className="workflow-studio" data-compact={compact || undefined} data-offline={!connected || undefined} data-mobile-tree={mobileTree || undefined} aria-label={t('WorkflowStudio.title')} data-follow-state={followState} onScrollCapture={(event) => { if (event.target === camera.current && summaries.current) summaries.current.scrollLeft = camera.current.scrollLeft; drawCurve() }}>
    {!compact && <div className="wf-route-strip">{lanes.map((lane, index) => <button type="button" key={lane.id} style={laneStyle(index)} aria-pressed={filter === lane.id} onClick={() => { setFilter(lane.id); setBrowsing(true); const latest = latestWorkflowEvent(events, lane.id); if (latest) setSelected(latest.key) }}><i />{lane.title}<span>→</span>{lane.agent && <><AgentIcon agent={lane.agent} />{agentLabel(lane.agent)}</>}<small>{t(PHASE_LABEL[lane.phase])}</small></button>)}<button type="button" className="wf-follow-control" aria-pressed={follow && !browsing} onClick={() => follow && !browsing ? setBrowsing(true) : resume()}>{t(follow && !browsing ? 'WorkflowStudio.following' : 'WorkflowStudio.resume')}</button></div>}
    <div className="wf-workspace">
      {!compact && <aside className="wf-routes" aria-label={t('WorkflowStudio.routes')}><button type="button" className="wf-all" aria-pressed={!filter} onClick={() => { setFilter(null); setBrowsing(true) }}>{t('WorkflowStudio.allEvents')}<small>{events.length}</small></button>
        {lanes.map((lane, index) => {
          const task = tasks.find((entry) => entry.id === lane.taskId)
          return <button type="button" className="wf-route" key={lane.id} style={laneStyle(index)} aria-pressed={filter === lane.id} onClick={() => { setFilter(lane.id); setBrowsing(true); const latest = latestWorkflowEvent(events, lane.id); if (latest) setSelected(latest.key) }}><strong><i />{lane.title}</strong><span>{lane.agent && <AgentIcon agent={lane.agent} />}{lane.agent ? agentLabel(lane.agent) : t('TaskExecutorPicker.chooseLater')}</span><code title={task?.repos[0]?.worktreePath ?? ''}>{task?.repos[0]?.branch ?? t('Workflow.createdOnStart')}</code><small>{t(PHASE_LABEL[lane.phase])}</small></button>
        })}

      </aside>}
      {!compact && <div className="wf-events"><header><strong>{selectedLane ? selectedLane.title : t('WorkflowStudio.allEvents')}</strong><span>{t('WorkflowStudio.eventHint')}</span><button type="button" className="button ghost wf-mobile-toggle" onClick={() => setMobileTree(true)}>{t('WorkflowStudio.tree')}</button></header>{selectedTask && renderTask && <details className="wf-active-controls" open><summary>{t('WorkflowStudio.taskControls')}</summary>{renderTask(selectedTask)}</details>}<div className="wf-event-scroll" ref={feed} onWheel={() => setBrowsing(true)} onTouchMove={() => setBrowsing(true)} tabIndex={0} aria-label={t('WorkflowStudio.allEvents')}>
        {hasOlder && <button type="button" className="button ghost wf-history" disabled={loading} onClick={() => void older()}>{t(loading ? 'WorkflowProcess.historyLoading' : historyError ? 'WorkflowProcess.retry' : 'WorkflowStudio.loadOlder')}</button>}
        {shown.map((event) => {
          const index = lanes.findIndex((lane) => lane.id === event.laneId)
          return <article key={event.key} className="wf-event" style={laneStyle(index)} data-event-row={event.key} data-selected={event.key === selected || undefined} data-phase={event.phase}>
            <button type="button" className="wf-event-heading" onClick={() => choose(event)} aria-pressed={event.key === selected}><span className="wf-event-symbol" data-kind={event.kind}>{SYMBOL[event.kind]}</span><span className="wf-event-lane">{lanes[index]?.title}</span><strong>{event.title}</strong><time>{eventTime(event.at)}</time></button>
            <div className="wf-event-meta">{event.agent && <><AgentIcon agent={event.agent} />{agentLabel(event.agent)}</>}<span>{t(KIND_LABEL[event.kind])}</span><span>{t(PHASE_LABEL[event.phase])}</span></div>
            {event.detail && <details open={event.key === selected && event.phase !== 'awaiting' || undefined}><summary>{t('WorkflowStudio.details')}</summary><pre>{event.detail}</pre></details>}
            <WorkflowRequest event={event} conversationId={lanes[index]?.conversationId ?? null} items={lanes[index]?.conversationId ? pages[lanes[index].conversationId]?.items ?? [] : []} connected={connected} />
            {event.key === selected && <button type="button" className="button ghost wf-open-record" onClick={() => openRecord(event)}>{t('WorkflowStudio.openRecord')} ↗</button>}
          </article>
        })}
        {!shown.length && <p className="muted wf-no-events">{t('WorkflowStudio.noEvents')}</p>}
      </div><footer>{selectedTask?.repos.map((repo) => <code key={repo.path} title={repo.worktreePath ?? repo.path}>{repo.worktreePath ?? repo.path}</code>) ?? <span>{t('Workflow.mode')}</span>}</footer></div>}
      <aside className="wf-tree" aria-label={t('WorkflowStudio.tree')}>
        <header><strong>{t('WorkflowStudio.tree')}</strong><span>{t('WorkflowStudio.laneCount', { count: lanes.length })}</span><button type="button" className="button ghost wf-mobile-toggle" onClick={() => setMobileTree(false)}>{t('WorkflowStudio.allEvents')}</button></header>
        <div className="wf-tree-summaries" ref={summaries} onScroll={() => { if (summaries.current && camera.current && camera.current.scrollLeft !== summaries.current.scrollLeft) camera.current.scrollLeft = summaries.current.scrollLeft }}>{lanes.map((lane, index) => <button type="button" key={lane.id} style={{ ...laneStyle(index), width: columnWidth, minWidth: columnWidth }} data-muted={selectedEvent && selectedEvent.laneId !== lane.id || undefined} onClick={() => { setFilter(lane.id); setBrowsing(true); const latest = latestWorkflowEvent(events, lane.id); if (latest) setSelected(latest.key) }}><strong><i />{lane.title}</strong><span>{lane.agent && <AgentIcon agent={lane.agent} />}{lane.agent ? agentLabel(lane.agent) : '—'}</span><small>{t(PHASE_LABEL[lane.phase])}</small></button>)}</div>
        <div className="wf-tree-toolbar"><label><input type="checkbox" checked={follow} onChange={(event) => { setPreference('workflowFollow', event.target.checked); setBrowsing(false) }} />{t('WorkflowProcess.follow')}</label>{browsing && follow && <button type="button" className="button ghost" onClick={resume}>{t('WorkflowStudio.resume')}</button>}<span>{connected ? selectedEvent ? eventTime(selectedEvent.at) : '' : t('WorkflowProcess.offline')}</span></div>
        {failed && <button type="button" className="button ghost" onClick={retry}>{t('WorkflowProcess.historyFailed')}</button>}
        <div className="wf-tree-camera" ref={camera} onWheel={() => setBrowsing(true)} onTouchMove={() => setBrowsing(true)} tabIndex={0} aria-label={t('WorkflowProcess.canvas')}><div className="wf-tree-canvas" style={{ width: lanes.length * columnWidth, height: Math.max(rowCount * step + 120, treeHeight) }}>
          <div className="wf-base">{t('WorkflowProcess.origin')} <code>{tasks[0]?.workflow?.bases[0]?.commit ? tasks[0].workflow.bases[0].commit.slice(0, 8) : 'BASE'}</code></div>
          <svg className="wf-rails" aria-hidden="true" width="100%" height="100%">{lanes.map((lane, index) => {
            const laneEvents = treeEvents.filter((event) => event.laneId === lane.id)
            const laneRows = laneEvents.map((event) => rows.get(event.key) ?? 0)
            const end = (laneRows.at(-1) ?? 0) * step + 64
            const from = Math.max(44, Math.min(end - 20, (laneRows.at(-2) ?? 0) * step + 64))
            const tail = Math.max(end + 48, rowCount * step + 64)
            const x = index * columnWidth + 14
            const live = lane.phase === 'running' || lane.phase === 'starting'
            return <g key={lane.id} style={laneStyle(index)} data-phase={lane.phase} data-muted={selectedEvent && selectedEvent.laneId !== lane.id || undefined}><path d={`M 14 26 Q ${x} 26 ${x} 44 L ${x} ${end}`} className="wf-rail" /><path d={`M ${x} ${end} L ${x} ${tail}`} className="wf-rail-tail" />{lane.phase === 'awaiting' && <path d={`M ${x} ${from} L ${x} ${end}`} className="wf-wait-rail" />}{live && <path d={`M ${x} ${from} L ${x} ${end}`} className="wf-live-rail" />}</g>
          })}</svg>
          {treeEvents.map((event) => {
            const index = lanes.findIndex((lane) => lane.id === event.laneId)
            return <button type="button" key={event.key} className="wf-tree-node" data-tree-event={event.key} data-kind={event.kind} data-phase={event.phase} data-selected={selected === event.key || undefined} data-muted={selectedEvent && selectedEvent.laneId !== event.laneId || undefined} aria-pressed={selected === event.key} aria-current={!browsing && follow && connected && selected === event.key && event.laneId === followed ? 'step' : undefined} style={{ ...laneStyle(index), left: index * columnWidth + 7, width: columnWidth - 8, top: (rows.get(event.key) ?? 0) * step + 53 }} title={`${event.title}\n${event.agent ? agentLabel(event.agent) : ''} · ${dayAndTime(event.at)}`} onClick={() => choose(event)}><span className="wf-node-mark" data-kind={event.kind}>{SYMBOL[event.kind]}</span><span><strong>{event.title}</strong><small>{event.agent ? agentLabel(event.agent) : ''} · {event.kind === 'current' ? t(PHASE_LABEL[event.phase]) : eventTime(event.at)}</small></span></button>
          })}
        </div></div>
        <footer className="wf-tree-legend">{(['stage', 'handoff', 'file', 'command', 'question', 'error', 'checkpoint'] as const).map((kind) => <span key={kind}><i data-kind={kind}>{SYMBOL[kind]}</i>{t(KIND_LABEL[kind])}</span>)}</footer>
      </aside>
    </div>
    {curve && <svg className="wf-event-connector" data-live={!browsing && follow && connected && selectedEvent?.laneId === followed || undefined} style={laneStyle(laneIndex)} aria-hidden="true"><path d={curve} /></svg>}
  </section>
}
