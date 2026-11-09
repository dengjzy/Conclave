import { useEffect, useId, useRef, useState } from 'react'
import { MAX_WORKFLOW_LANES, type AgentKind, type Task } from '@conclave/protocol'
import { dismissError, perform, useCore } from '../core-store'
import { t } from '../i18n'
import { useInstalledAgents } from '../installed-agents'
import { agentLabel } from '../labels'
import { latestProjects } from '../task-board'
import { AgentIcon } from './icons'
import { ChatPicker } from './ChatPicker'
import { ProjectPicker } from './ProjectPicker'

type LaneDraft = { key: number; name: string; agent: AgentKind | null; instructions: string }

export function NewWorkflowDialog({ source, onClose, onCreated }: { source?: Task; onClose: () => void; onCreated: (task: Task) => void }) {
  const installed = useInstalledAgents()
  const tasks = useCore((s) => s.tasks)
  const connected = useCore((s) => s.connection === 'connected')
  const error = useCore((s) => s.error)
  const dialog = useRef<HTMLDialogElement>(null)
  const submitting = useRef(false)
  const nextKey = useRef(2)
  const ids = useId()
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [repos, setRepos] = useState<string[]>(() => latestProjects(Object.values(tasks)))
  const [busy, setBusy] = useState(false)
  const [lanes, setLanes] = useState<LaneDraft[]>(() => source
    ? [{ key: 0, name: '', agent: installed[0] ?? null, instructions: '' }]
    : [0, 1].map((key) => ({ key, name: t('Workflow.laneNumber', { number: key + 1 }), agent: installed[key] ?? installed[0] ?? null, instructions: '' })))
  const valid = connected && !busy && (source || (title.trim() && repos.length)) && lanes.every((lane) => lane.name.trim()) && new Set(lanes.map((lane) => lane.name.trim().toLowerCase())).size === lanes.length
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    element?.querySelector<HTMLInputElement>('input')?.focus()
    dismissError()
    return () => element?.close()
  }, [])
  const patch = (key: number, fields: Partial<LaneDraft>) => setLanes((current) => current.map((lane) => lane.key === key ? { ...lane, ...fields } : lane))
  async function submit() {
    if (!valid || submitting.current) return
    submitting.current = true
    setBusy(true)
    dismissError()
    const fields = lanes.map(({ name, agent, instructions }) => ({ name: name.trim(), agent, instructions }))
    const result = await perform((rpc) => source && fields[0]
      ? rpc.call('tasks.addWorkflowLane', { id: source.id, ...fields[0] }).then((task) => [task])
      : rpc.call('tasks.createWorkflow', { title: title.trim(), details, repos, lanes: fields }))
    setBusy(false)
    submitting.current = false
    if (result?.[0]) onCreated(result[0])
  }
  return <dialog ref={dialog} className="modal workflow-dialog" aria-labelledby={`${ids}-title`} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }} onClick={(event) => { if (event.target === dialog.current && !busy) onClose() }}>
    <div className="modal-body workflow-form">
      <header className="workflow-heading"><h2 id={`${ids}-title`}>{t(source ? 'Workflow.addLane' : 'Workflow.new')}</h2><button type="button" className="button ghost" disabled={busy} onClick={onClose}>{t('BackdropPicker.close')}</button></header>
      <p className="muted">{t('Workflow.mode')}</p>
      {source ? <p>{source.workflow?.title}</p> : <>
        <label>{t('Workflow.title')}<input className="input" value={title} maxLength={120} autoFocus onChange={(event) => setTitle(event.target.value)} required /></label>
        <label>{t('Workflow.request')}<textarea className="input" rows={4} value={details} maxLength={80_000} onChange={(event) => setDetails(event.target.value)} /></label>
        <div><span>{t('ChatMentionMenu.project')}</span><ProjectPicker projects={repos.map((path) => ({ path, worktreePath: null }))} onChange={setRepos} preferPathEntry /></div>
      </>}
      <p className="muted">{t(source ? 'Workflow.addRule' : 'Workflow.baseRule')}</p>
      <fieldset disabled={busy}><legend>{t('Workflow.lanes')}</legend>
        {lanes.map((lane, index) => <div className="workflow-lane-draft" key={lane.key}>
          <div className="workflow-heading"><label>{t('Workflow.laneNumber', { number: index + 1 })}<input className="input" aria-label={t('Workflow.laneName', { number: index + 1 })} value={lane.name} required maxLength={60} onChange={(event) => patch(lane.key, { name: event.target.value })} /></label>
            <ChatPicker label={t('TaskExecutorPicker.taskAssignee')} value={lane.agent ?? ''} placeholder="Agent" options={installed.map((agent) => ({ value: agent, label: agentLabel(agent), icon: <AgentIcon agent={agent} /> }))} onChange={(value) => patch(lane.key, { agent: installed.find((agent) => agent === value) ?? null })} />
            {!source && lanes.length > 1 && <button type="button" className="button ghost" onClick={() => setLanes((current) => current.filter((other) => other.key !== lane.key))}>{t('Workflow.remove')}</button>}
          </div>
          <label>{t('Workflow.instructions')}<textarea className="input" rows={2} value={lane.instructions} maxLength={20_000} onChange={(event) => patch(lane.key, { instructions: event.target.value })} /></label>
        </div>)}
      </fieldset>
      {!source && lanes.length < MAX_WORKFLOW_LANES && <button type="button" className="button ghost" disabled={busy} onClick={() => { const key = nextKey.current++; setLanes((current) => [...current, { key, name: '', agent: installed[current.length % installed.length] ?? null, instructions: '' }]) }}>{t('Workflow.addLane')}</button>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="workflow-footer"><span className="muted">{t('Workflow.createRule')}</span><button className="button primary" type="button" disabled={!valid} onClick={() => void submit()}>{t(busy ? 'Workflow.creating' : source ? 'Workflow.addLane' : 'Workflow.create')}</button></footer>
    </div>
  </dialog>
}
