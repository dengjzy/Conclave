import { useEffect, useId, useRef, useState } from 'react'
import { agentDescriptor, type AgentKind, type AgentProfile, type ChatItem, type Conversation } from '@conclave/protocol'
import { agentCallForResult, openAgentCall, showAgentCalls, useAgentCalls, useAgentCallsSupported } from '../agent-calls'
import { useAgentCatalog, type ModelChoice } from '../agent-models'
import { useCore } from '../core-store'
import { delegationAgent, delegationAgents, delegationInstruction, delegationReadOnly, delegationRoleFields, directDelegationAllowed, directDelegationTarget } from '../delegation-choice'
import { discussionModelUnavailable } from '../discussion-model'
import { t } from '../i18n'
import { useInstalledAgents } from '../installed-agents'
import { agentLabel } from '../labels'
import { AgentModelPicker } from './AgentModelPicker'
import { ChatPicker } from './ChatPicker'
import { ProviderPicker } from './ProviderPicker'
import { useChatSurface } from './chat-surface'
import { useConversationPane } from './conversation-pane'
import { AgentIcon, CloseIcon, SquadIcon } from './icons'
import './agent-calls.css'

export function DelegationDialog({ conversation, onClose, onHistory }: { conversation: Conversation; onClose(): void; onHistory(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const rpc = useCore((state) => state.rpc)
  const profiles = useCore((state) => state.agentProfiles)
  const environment = useCore((state) => state.environment)
  const installed = useInstalledAgents()
  const agents = delegationAgents(environment, installed)
  const directAllowed = directDelegationAllowed(conversation, rpc?.features ?? [])
  const [mode, setMode] = useState<'direct' | 'profile'>(() => directAllowed ? 'direct' : 'profile')
  const direct = directAllowed && mode === 'direct'
  const [agentChoice, setAgentChoice] = useState<AgentKind | null>(() => delegationAgent(agents, null))
  const agent = delegationAgent(agents, agentChoice)
  useEffect(() => { if (!agentChoice && agent) setAgentChoice(agent) }, [agentChoice, agent])
  const [choice, setChoice] = useState<ModelChoice>({})
  const [modelProvider, setModelProvider] = useState<string | null>(null)
  const provider = useCore((state) => state.modelProviders.find((item) => item.id === modelProvider) ?? null)
  const [capability, setCapability] = useState<'readOnly' | 'develop'>('readOnly')
  const forcedReadOnly = delegationReadOnly(conversation)
  const readOnlyUnsupported = Boolean(agent && (forcedReadOnly || capability === 'readOnly') && agentDescriptor(agent).capabilities.readOnly === false)
  const catalog = useAgentCatalog(agent, direct && !readOnlyUnsupported, provider)
  const target = directDelegationTarget(conversation, agent, capability, catalog, choice, provider?.id ?? null)
  const [roleName, setRoleName] = useState('')
  const [saving, setSaving] = useState(false)
  const [available, setAvailable] = useState<AgentProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(crypto.randomUUID())
  const resetRef = () => { requestRef.current = crypto.randomUUID() }
  useEffect(resetRef, [direct, agent, choice.model, choice.effort, target?.model, target?.effort, modelProvider, provider?.id, capability, forcedReadOnly])
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
  const instruction = delegationInstruction(goal, context)
  const ready = direct ? Boolean(target) : Boolean(selected)
  const locked = busy || saving
  const saveRole = async () => {
    if (!rpc || locked || !target || !roleName.trim()) return
    setSaving(true)
    setError(null)
    try {
      const saved = await rpc.call('agentProfiles.save', delegationRoleFields(target, roleName))
      useCore.setState((state) => ({ agentProfiles: { ...state.agentProfiles, [saved.id]: saved } }))
      setAvailable((known) => [saved, ...known.filter((item) => item.id !== saved.id)])
      setProfileId(saved.id)
      setMode('profile')
      resetRef()
    } catch (reason) { setError(String(reason)) } finally { setSaving(false) }
  }
  const dispatch = async () => {
    if (!rpc || locked || !ready || !goal.trim() || instruction.length > 20000 || (conversation.archivedAt != null || Boolean(conversation.deletion))) return
    setBusy(true)
    setError(null)
    try {
      if (direct && target) await rpc.call('agentCalls.dispatch', { id: conversation.id, target, instruction, ref: requestRef.current })
      else if (selected) await rpc.call('agentCalls.dispatch', { id: conversation.id, profileId: selected.id, instruction, ref: requestRef.current })
      onHistory()
      onClose()
    } catch (reason) { setError(String(reason)); setBusy(false) }
  }
  return <dialog ref={dialog} className="modal delegation-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!locked) onClose() }}>
    <form className="modal-body" onSubmit={(event) => { event.preventDefault(); void dispatch() }}>
      <header className="modal-header"><h2 id={titleId}>{t('AgentProfiles.delegate')}</h2><button type="button" className="icon-button modal-close" aria-label={t('BackdropPicker.close')} disabled={locked} onClick={onClose}><CloseIcon /></button></header>
      <p className="delegation-hint muted">{t('AgentProfiles.dispatchHint')}</p>
      {directAllowed && <div className="delegation-field"><ChatPicker label={t('Delegation.target')} value={mode} placeholder="" size="field" placement="below" disabled={locked} options={[{ value: 'direct', label: t('Delegation.direct') }, { value: 'profile', label: t('Delegation.savedRole') }]} onChange={(value) => { setMode(value === 'profile' ? 'profile' : 'direct'); resetRef() }} /></div>}
      {!directAllowed && conversation.profile && <p className="muted delegation-hint">{t('Delegation.roleRestricted')}</p>}
      {direct ? <>
        <div className="delegation-options">
          <div className="delegation-field"><ChatPicker label={t('Delegation.tool')} value={agent} placeholder={t('Delegation.chooseTool')} size="field" placement="below" disabled={locked || !agents.length} options={agents.map((item) => ({ value: item, label: agentLabel(item), icon: <AgentIcon agent={item} /> }))} onChange={(value) => {
            const next = agents.find((item) => item === value)
            if (next) { setAgentChoice(next); setChoice({}); setModelProvider(null); resetRef() }
          }} /></div>
          <div className="delegation-field"><AgentModelPicker catalog={catalog} choice={choice} size="field" disabled={locked || readOnlyUnsupported} onChange={(next) => { setChoice(next); resetRef() }} /></div>
        </div>
        {!agents.length && <p className="muted delegation-hint">{t('Delegation.noTools')}</p>}
        {agentChoice && !agent && agents.length > 0 && <p className="modal-error" role="alert">{t('Delegation.toolUnavailable')}</p>}
        {agent && <ProviderPicker agent={agent} value={modelProvider} size="field" placement="below" disabled={locked} onChange={(value) => { setModelProvider(value); setChoice({}); resetRef() }} />}
        <ChatPicker label={t('Delegation.access')} value={forcedReadOnly ? 'readOnly' : capability} placeholder="" size="field" placement="below" disabled={locked || forcedReadOnly} options={[{ value: 'readOnly', label: t('Delegation.readOnly') }, { value: 'develop', label: t('Delegation.develop') }]} onChange={(value) => { setCapability(value === 'develop' ? 'develop' : 'readOnly'); resetRef() }} />
        {(forcedReadOnly || readOnlyUnsupported) && <p className="delegation-hint muted" role={readOnlyUnsupported ? 'alert' : undefined}>{t(readOnlyUnsupported ? 'Delegation.readOnlyUnsupported' : 'Delegation.parentReadOnly')}</p>}
        {discussionModelUnavailable(catalog, choice) && <p className="modal-error" role="alert">{t('DiscussionDraft.modelUnavailable', { model: choice.model ?? '' })}</p>}
        <details className="delegation-save"><summary>{t('Delegation.saveRole')}</summary><label className="delegation-field">{t('Delegation.roleName')}<input className="input" value={roleName} maxLength={60} disabled={locked} onChange={(event) => setRoleName(event.target.value)} /></label><p className="muted delegation-hint">{t('Delegation.saveHint')}</p><button type="button" className="button ghost" disabled={locked || !target || !roleName.trim()} onClick={() => void saveRole()}>{t('FileEditor.save')}</button></details>
      </> : <>
        <div className="delegation-field"><ChatPicker label={t('Delegation.savedRole')} value={profileId} placeholder={t('AgentProfiles.chooseRole')} size="field" placement="below" disabled={locked || loading} options={available.map((item) => ({ value: item.id, label: item.name, description: item.description, icon: <AgentIcon agent={item.agent} /> }))} onChange={(value) => { setProfileId(value); resetRef() }} /></div>
        {!loading && !available.length && <p className="muted">{t('AgentProfiles.noAvailable')}</p>}
        {selected && <p className="muted delegation-hint">{[agentLabel(selected.agent), selected.model, t(selected.capability === 'readOnly' || forcedReadOnly ? 'Delegation.readOnly' : 'Delegation.develop')].filter(Boolean).join(' · ')}</p>}
      </>}
      <label className="delegation-field">{t('AgentProfiles.goal')}<textarea className="input" autoFocus required rows={3} maxLength={10000} placeholder={t('AgentProfiles.goalPlaceholder')} value={goal} disabled={locked} onChange={(event) => { setGoal(event.target.value); resetRef() }} /></label>
      <label className="delegation-field">{t('AgentProfiles.context')}<textarea className="input" rows={2} maxLength={9998} placeholder={t('AgentProfiles.contextPlaceholder')} value={context} disabled={locked} onChange={(event) => { setContext(event.target.value); resetRef() }} /></label>
      <div className="delegation-handoff"><strong>{t('Delegation.sharedProjects')}</strong><ul>{(conversation.projectPaths.length ? conversation.projectPaths : [conversation.workspacePath]).map((path) => <li key={path}>{path}</li>)}</ul>{Boolean(conversation.referencePaths?.length) && <><strong>{t('Delegation.references')}</strong><ul>{conversation.referencePaths?.map((path) => <li key={path}>{path}</li>)}</ul></>}<p className="muted">{t('Delegation.historyHint')}</p></div>
      {instruction && <details className="delegation-preview"><summary>{t('Delegation.preview')}</summary><pre>{instruction}</pre></details>}
      {error && <p className="modal-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="link-button delegation-history" disabled={locked} onClick={() => { onHistory(); onClose() }}>{t('AgentProfiles.history')}</button><button type="button" className="button ghost" disabled={locked} onClick={onClose}>{t('ChatCommandSettings.cancel')}</button><button type="submit" className="button primary" disabled={locked || !ready || !goal.trim() || instruction.length > 20000 || (conversation.archivedAt != null || Boolean(conversation.deletion))}>{busy ? t('AgentProfiles.starting') : t('AgentProfiles.dispatch')}</button></footer>
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
    <button type="button" className="tool-button delegation-button" aria-label={t('AgentProfiles.delegate')} aria-haspopup="dialog" aria-expanded={open} data-tooltip={t('AgentProfiles.delegate')} disabled={(conversation.archivedAt != null || Boolean(conversation.deletion))} onClick={() => setOpen(true)}><SquadIcon /><span>{t('AgentProfiles.delegate')}</span>{working > 0 && <span className="delegation-count" aria-label={`${t('AgentProfiles.running')} ${working}`}>{working}</span>}</button>
    {open && <DelegationDialog key={conversation.id} conversation={conversation} onClose={() => setOpen(false)} onHistory={history} />}
  </>
}

export function AgentDelegationResult({ conversationId, item }: { conversationId: string; item: Pick<ChatItem, 'kind' | 'id'> }) {
  const surface = useChatSurface()
  const pane = useConversationPane()
  const { calls } = useAgentCalls(conversationId)
  const call = agentCallForResult(item, calls)
  return <div className="delegation-delivery"><SquadIcon /><span>{t('AgentProfiles.resultReturned')}</span>{call && <button type="button" className="link-button" onClick={() => void openAgentCall(call)}>{call.profile.name} · {t('AgentProfiles.openConversation')}</button>}<button type="button" className="link-button" onClick={() => { pane?.focus(); showAgentCalls(surface.inspector) }}>{t('AgentProfiles.history')}</button></div>
}
