import { useEffect, useId, useRef, useState } from 'react'
import type { AgentProfile, Conversation } from '@conclave/protocol'
import { showAgentCalls, useAgentCallsSupported } from '../agent-calls'
import { useOccludesBrowser } from '../browser-occlusion'
import { useCore } from '../core-store'
import { t } from '../i18n'
import { ChatPicker } from './ChatPicker'
import { useChatSurface } from './chat-surface'
import { useConversationPane } from './conversation-pane'
import { AgentIcon, CloseIcon, SquadIcon } from './icons'
import './agent-calls.css'

function DelegationDialog({ conversation, onClose, onHistory }: { conversation: Conversation; onClose(): void; onHistory(): void }) {
  useOccludesBrowser()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const rpc = useCore((state) => state.rpc)
  const profiles = useCore((state) => state.agentProfiles)
  const [available, setAvailable] = useState<AgentProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(crypto.randomUUID())
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  useEffect(() => {
    if (!rpc) return
    let current = true
    void rpc.call('agentProfiles.available', { id: conversation.id }).then((items) => {
      if (current) { setAvailable(items); setLoading(false) }
    }).catch((reason: unknown) => { if (current) { setError(String(reason)); setLoading(false) } })
    return () => { current = false }
  }, [rpc, conversation.id, profiles])
  const selected = available.find((item) => item.id === profileId)
  const dispatch = async () => {
    if (!rpc || busy || !selected || !goal.trim() || conversation.archivedAt != null) return
    setBusy(true)
    setError(null)
    try {
      await rpc.call('agentCalls.dispatch', { id: conversation.id, profileId: selected.id, instruction: [goal.trim(), context.trim()].filter(Boolean).join('\n\n'), ref: requestRef.current })
      onHistory()
      onClose()
    } catch (reason) { setError(String(reason)); setBusy(false) }
  }
  return <dialog ref={dialog} className="modal delegation-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <form className="modal-body" onSubmit={(event) => { event.preventDefault(); void dispatch() }}>
      <header className="modal-header"><h2 id={titleId}>{t('AgentProfiles.delegate')}</h2><button type="button" className="icon-button modal-close" aria-label={t('BackdropPicker.close')} disabled={busy} onClick={onClose}><CloseIcon /></button></header>
      <p className="delegation-hint muted">{t('AgentProfiles.dispatchHint')}</p>
      <div className="delegation-field"><span>{t('AgentProfiles.role')}</span><ChatPicker label={t('AgentProfiles.role')} value={profileId} placeholder={t('AgentProfiles.chooseRole')} size="field" placement="below" disabled={busy || loading} options={available.map((item) => ({ value: item.id, label: item.name, description: item.description, icon: <AgentIcon agent={item.agent} /> }))} onChange={(value) => { setProfileId(value); requestRef.current = crypto.randomUUID() }} /></div>
      {!loading && !available.length && <p className="muted">{t('AgentProfiles.noAvailable')}</p>}
      <label className="delegation-field">{t('AgentProfiles.goal')}<textarea className="input" autoFocus required rows={3} maxLength={10000} placeholder={t('AgentProfiles.goalPlaceholder')} value={goal} disabled={busy} onChange={(event) => { setGoal(event.target.value); requestRef.current = crypto.randomUUID() }} /></label>
      <label className="delegation-field">{t('AgentProfiles.context')}<textarea className="input" rows={2} maxLength={9998} placeholder={t('AgentProfiles.contextPlaceholder')} value={context} disabled={busy} onChange={(event) => { setContext(event.target.value); requestRef.current = crypto.randomUUID() }} /></label>
      {error && <p className="modal-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="link-button delegation-history" disabled={busy} onClick={() => { onHistory(); onClose() }}>{t('AgentProfiles.history')}</button><button type="button" className="button ghost" disabled={busy} onClick={onClose}>{t('ChatCommandSettings.cancel')}</button><button type="submit" className="button primary" disabled={busy || !selected || !goal.trim() || conversation.archivedAt != null}>{busy ? t('AgentProfiles.starting') : t('AgentProfiles.dispatch')}</button></footer>
    </form>
  </dialog>
}

export function AgentDelegation({ conversation }: { conversation: Conversation }) {
  const supported = useAgentCallsSupported(conversation)
  const [open, setOpen] = useState(false)
  const surface = useChatSurface()
  const pane = useConversationPane()
  if (!supported) return null
  const history = () => {
    pane?.focus()
    showAgentCalls(surface.inspector)
  }
  const working = conversation.delegation?.open ?? 0
  return <>
    <button type="button" className="tool-button delegation-button" aria-label={t('AgentProfiles.delegate')} aria-haspopup="dialog" aria-expanded={open} data-tooltip={t('AgentProfiles.delegate')} disabled={conversation.archivedAt != null} onClick={() => setOpen(true)}><SquadIcon /><span>{t('AgentProfiles.dispatch')}</span>{working > 0 && <span className="delegation-count" aria-label={`${t('AgentProfiles.running')} ${working}`}>{working}</span>}</button>
    {open && <DelegationDialog key={conversation.id} conversation={conversation} onClose={() => setOpen(false)} onHistory={history} />}
  </>
}

export function AgentDelegationResult() {
  const surface = useChatSurface()
  const pane = useConversationPane()
  return <div className="delegation-delivery"><SquadIcon /><span>{t('AgentProfiles.resultReturned')}</span><button type="button" className="link-button" onClick={() => { pane?.focus(); showAgentCalls(surface.inspector) }}>{t('AgentProfiles.history')}</button></div>
}
