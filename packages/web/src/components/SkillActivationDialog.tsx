import { useEffect, useId, useRef, useState } from 'react'
import { AGENT_KINDS, activatedSkillNames, agentDescriptor, skillNameConflicts, type AgentKind, type SkillActivation, type SkillRef, type SkillRepo } from '@conclave/protocol'
import { useOccludesBrowser } from '../browser-occlusion'
import { perform } from '../core-store'
import { t } from '../i18n'
import { agentLabel } from '../labels'
import { CloseIcon } from './icons'
import { Segmented, SettingsRow } from './SettingsControls'

const takers = AGENT_KINDS.filter((kind) => agentDescriptor(kind).capabilities.skills)

export function SkillActivationDialog({ repo, repos, fallback, onClose, onManage }: { repo: SkillRepo; repos: readonly SkillRepo[]; fallback: readonly SkillRef[]; onClose: () => void; onManage: (id: string) => void }) {
  useOccludesBrowser()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [draft, setDraft] = useState<SkillActivation>(() => repo.activation ?? { mode: 'selected', skills: activatedSkillNames(repo, fallback), agents: null })
  const [saving, setSaving] = useState(false)
  const effective = repos.map((each) => each.id === repo.id ? { ...each, activation: draft } : each.activation ? each : { ...each, activation: { mode: 'selected' as const, skills: activatedSkillNames(each, fallback), agents: null } })
  const conflicts = skillNameConflicts(effective, takers).filter((conflict) => conflict.repos.includes(repo.id))
  const usable = repo.skills.filter((skill) => skill.problem === null)
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  const selectAgents = (agents: AgentKind[] | null) => setDraft((current) => ({ ...current, agents }))
  const save = async () => {
    if (saving || conflicts.length) return
    setSaving(true)
    try {
      const result = await perform((rpc) => rpc.call('skills.setActivation', { id: repo.id, activation: draft }))
      if (result) onClose()
    } finally { setSaving(false) }
  }
  return <dialog ref={dialog} className="modal skill-activation-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!saving) onClose() }}>
    <form className="modal-body" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <header className="modal-header"><h2 id={titleId}>{repo.plugin?.name ?? repo.id}</h2><button type="button" className="icon-button modal-close" aria-label={t('BackdropPicker.close')} disabled={saving} onClick={onClose}><CloseIcon /></button></header>
      <p className="settings-note skill-repo-url">{repo.url}</p>
      <fieldset className="skill-activation-fields" disabled={saving}>
        <SettingsRow label={t('SkillsSettingsSection.activationMode')} control={(labelId) => <Segmented labelId={labelId} value={draft.mode} options={[{ value: 'all', label: t('SkillsSettingsSection.enableAll') }, { value: 'selected', label: t('SkillsSettingsSection.selectSkills') }]} onChange={(mode) => setDraft((current) => ({ ...current, mode, skills: mode === 'selected' && current.mode === 'all' ? usable.map((skill) => skill.name) : current.skills }))} />}/>
        <SettingsRow label={t('SkillsSettingsSection.agentScope')} control={(labelId) => <Segmented labelId={labelId} value={draft.agents === null ? 'all' : 'selected'} options={[{ value: 'all', label: t('SkillsSettingsSection.allCompatibleAgents') }, { value: 'selected', label: t('SkillsSettingsSection.specificAgents') }]} onChange={(scope) => selectAgents(scope === 'all' ? null : [...takers])} />}/>
        {draft.agents === null ? <p className="settings-note">{t('SkillsSettingsSection.futureAgents')}</p> : <>
          <div className="skill-selection-actions"><button type="button" className="button ghost" onClick={() => selectAgents([...takers])}>{t('SkillsSettingsSection.selectAll')}</button><button type="button" className="button ghost" onClick={() => selectAgents([])}>{t('SidebarSearch.clear')}</button></div>
          <div className="skill-agent-choices">{AGENT_KINDS.map((kind) => <label className="mcp-agent" key={kind}><input type="checkbox" disabled={!takers.includes(kind)} checked={draft.agents?.includes(kind) ?? false} onChange={(event) => selectAgents(event.target.checked ? [...(draft.agents ?? []), kind] : (draft.agents ?? []).filter((agent) => agent !== kind))}/>{agentLabel(kind)}{!takers.includes(kind) && <span className="muted">{t('SkillsSettingsSection.unsupported')}</span>}</label>)}</div>
          {draft.agents.length === 0 && <p className="settings-note">{t('SkillsSettingsSection.noAgents')}</p>}
        </>}
        <div className="skill-selection-actions"><span>{t('SkillsSettingsSection.skills')}</span>{draft.mode === 'selected' && <><button type="button" className="button ghost" onClick={() => setDraft((current) => ({ ...current, skills: usable.map((skill) => skill.name) }))}>{t('SkillsSettingsSection.selectAll')}</button><button type="button" className="button ghost" onClick={() => setDraft((current) => ({ ...current, skills: [] }))}>{t('SidebarSearch.clear')}</button></>}</div>
        <div className="skill-selection-list">{repo.skills.map((skill) => <label className="skill-selection-row" key={skill.dir}>
          <input type="checkbox" disabled={draft.mode === 'all' || skill.problem !== null} checked={skill.problem === null && (draft.mode === 'all' || draft.skills.includes(skill.name))} onChange={(event) => setDraft((current) => ({ ...current, skills: event.target.checked ? [...current.skills, skill.name] : current.skills.filter((name) => name !== skill.name) }))}/>
          <span><span className="skill-selection-name">{skill.name}</span><span className="skill-selection-description">{skill.problem ?? skill.description}</span></span>
        </label>)}</div>
      </fieldset>
      {conflicts.length > 0 && <div className="skill-conflicts" role="alert"><p>{t('SkillsSettingsSection.conflicts')}</p>{conflicts.map((conflict) => <div key={`${conflict.agent}:${conflict.name}`}><strong>{conflict.name}</strong> · {agentLabel(conflict.agent)}<div>{conflict.repos.filter((id) => id !== repo.id).map((id) => <button type="button" className="button ghost" key={id} disabled={saving} onClick={() => onManage(id)}>{t('SkillsSettingsSection.manageSource', { name: id })}</button>)}</div></div>)}</div>}
      <p className="settings-note">{t('SkillsSettingsSection.activationTiming')}</p>
      <footer className="modal-footer"><button type="button" className="button ghost" disabled={saving} onClick={onClose}>{t('ChatCommandSettings.cancel')}</button><button type="submit" className="button primary" disabled={saving || conflicts.length > 0}>{saving ? t('McpSettingsSection.saving') : t('FileEditor.save')}</button></footer>
    </form>
  </dialog>
}
