import { t, tr } from '../i18n'
import { useEffect, useState } from 'react'
import { knowledgeBaseKind, type KnowledgeBaseKind, type KnowledgeFolder, type KnowledgeVault } from '@conclave/protocol'
import { perform, setChatSettings, useCore, useSkillsSupported } from '../core-store'
import { canPickFolder, pickFolder } from '../desktop-bridge'
import { projectName } from './ProjectPicker'
import { Segmented, SettingsRow, Toggle } from './SettingsControls'

export function KnowledgeBaseSettings() {
  const connected = useCore((s) => s.connection === 'connected')
  const chatSettings = useCore((s) => s.chatSettings)
  const skillsSupported = useSkillsSupported()
  const kindsSupported = useCore((s) => s.rpc?.features.includes('knowledge-base-kind') ?? false)
  const hasObsidianSkills = useCore((s) => s.skillRepos.some((repo) => repo.skills.some((skill) => skill.name === 'obsidian-markdown' && skill.problem === null)))
  const chosen = chatSettings?.knowledgeBase ?? null
  const chosenPath = chosen?.path ?? null
  const [pendingKind, setPendingKind] = useState<KnowledgeBaseKind>('markdown')
  const kind = kindsSupported ? (chosen ? knowledgeBaseKind(chosen) : pendingKind) : 'obsidian'
  const [vaults, setVaults] = useState<KnowledgeVault[] | null>(null)
  const [folder, setFolder] = useState<KnowledgeFolder | null>(null)

  useEffect(() => {
    if (!connected || kind !== 'obsidian') { setVaults(null); return }
    let current = true
    void perform((rpc) => rpc.call('knowledge.vaults', {})).then((found) => { if (current) setVaults(found ?? []) })
    return () => { current = false }
  }, [connected, kind])

  // What the chosen folder holds: known from the listing, else asked.
  useEffect(() => {
    if (!connected || !chosenPath) { setFolder(null); return }
    const listed = vaults?.find((vault) => vault.path === chosenPath)
    if (listed) { setFolder({ vault: true, skillDirs: listed.skillDirs }); return }
    setFolder(null)
    let current = true
    void perform((rpc) => rpc.call('knowledge.inspect', { path: chosenPath })).then((found) => { if (current) setFolder(found) })
    return () => { current = false }
  }, [connected, chosenPath, vaults])

  const changeKind = (next: KnowledgeBaseKind) => {
    setPendingKind(next)
    if (chosen) void setChatSettings({ knowledgeBase: { ...chosen, kind: next } })
  }
  const use = (path: string) => {
    void setChatSettings({ knowledgeBase: { path, write: chosen?.write ?? true, ...(kindsSupported ? { kind: 'obsidian' } : {}) } })
  }
  const browse = async () => {
    const picked = await pickFolder(chosenPath ?? undefined, kind === 'obsidian' ? t('KnowledgeBaseSettings.chooseObsidianVault') : t('KnowledgeBaseSettings.chooseMarkdownFolder'))
    if (!picked) return
    void setChatSettings({ knowledgeBase: { path: picked, write: chosen?.write ?? true, ...(kindsSupported ? { kind } : {}) } })
  }

  if (!connected) return <p className="settings-empty">{t('ChatCommandSettings.connectToConclaveCoreToView')}</p>
  if (!chatSettings) return <p className="settings-empty">{t('DashboardPanel.loading')}</p>
  const others = (vaults ?? []).filter((vault) => vault.path !== chosenPath)
  return (
    <>
      <p className="settings-note">{t('KnowledgeBaseSettings.agentCanReadMaterialsAndSaveSummariesAnd')}</p>
      {kindsSupported && <SettingsRow
        label={t('KnowledgeBaseSettings.knowledgeBaseType')}
        description={kind === 'markdown' ? t('KnowledgeBaseSettings.useStandardMarkdownAndRelativeLinksFollowingExisting') : t('KnowledgeBaseSettings.useObsidianMarkdownWithWikilinksAndProperties')}
        control={(labelId) => <Segmented<KnowledgeBaseKind>
          labelId={labelId}
          value={kind}
          options={[{ value: 'markdown', label: t('KnowledgeBaseSettings.markdownFolder') }, { value: 'obsidian', label: 'Obsidian' }]}
          onChange={changeKind}
        />}
      />}
      {chosen ? (
        <>
          <ul className="settings-project-list">
            <li className="settings-project">
              <span className="settings-project-name">{projectName(chosen.path)}</span>
              <span className="settings-project-path mono" title={chosen.path}>{chosen.path}</span>
              <button type="button" className="button" onClick={() => void setChatSettings({ knowledgeBase: null })}>{t('KnowledgeBaseSettings.disable')}</button>
            </li>
          </ul>
          {kind === 'obsidian' && folder && !folder.vault && <p className="settings-note">{t('KnowledgeBaseSettings.thisFolderHasNoObsidianDirectoryObsidianMay')}</p>}
          {kind === 'obsidian' && skillsSupported && !hasObsidianSkills && (
            <p className="settings-note">{t('KnowledgeBaseSettings.installTheRecommendedObsidianSkillInSettingsSkills')}</p>
          )}
          {folder && folder.skillDirs.length > 0 && (
            <p className="settings-note warning">{tr('KnowledgeBaseSettings.vaultContainsAgentLoadsTheseSkillsTooUsing', { value1: folder.skillDirs.join('、') })}</p>
          )}
          <SettingsRow
            label={t('KnowledgeBaseSettings.allowWriting')}
            description={t('KnowledgeBaseSettings.whenOffAgentCanOnlyReadTheKnowledge')}
            control={(labelId) => (
              <Toggle labelId={labelId} checked={chosen.write} onChange={(write) => void setChatSettings({ knowledgeBase: { ...chosen, write } })} />
            )}
          />
        </>
      ) : (
        <p className="settings-empty">{t('KnowledgeBaseSettings.noKnowledgeBaseSelected')}</p>
      )}
      {kind === 'obsidian' && others.length > 0 && (
        <>
          <h3 className="settings-stats-heading">{t('KnowledgeBaseSettings.obsidianVaults')}</h3>
          <ul className="settings-project-list">
            {others.map((vault) => (
              <li key={vault.path} className="settings-project">
                <span className="settings-project-name">{vault.name}{vault.open ? t('KnowledgeBaseSettings.open') : ''}</span>
                <span className="settings-project-path mono" title={vault.path}>{vault.path}</span>
                <button type="button" className="button" onClick={() => use(vault.path)}>{t('KnowledgeBaseSettings.use')}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {canPickFolder() && (
        <p className="settings-note">
          <button type="button" className="button" onClick={() => void browse()}>{kind === 'markdown' ? t('KnowledgeBaseSettings.chooseMarkdownFolder_1194') : t('KnowledgeBaseSettings.chooseAnotherFolder')}</button>
        </p>
      )}
    </>
  )
}
