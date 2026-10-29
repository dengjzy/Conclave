import { useEffect, useId, useMemo, useState } from 'react'
import type { AgentKind, Conversation, ExternalSession } from '@conclave/protocol'
import { t } from '../i18n'
import { perform, selectConversation, useCore } from '../core-store'
import { agentLabel } from '../labels'
import { timeAgo } from '../conversation-state'
import { AgentIcon, ChevronRightIcon, RefreshIcon } from './icons'
import { projectName } from './ProjectPicker'
import { useExternalSessions } from '../external-sessions'
import { Segmented, Toggle } from './SettingsControls'
import { askConfirm } from '../confirm-dialog'

const keyOf = (session: ExternalSession) => `${session.agent}:${session.sessionId}`

const isSelectable = (session: ExternalSession, tab: 'import' | 'cleanup') =>
  tab === 'cleanup' ? true : session.problem === null && session.status !== 'imported'

// Sessions Claude Code, Codex, Antigravity, Pi and ZCode ran outside Conclave, listed by the folder they ran in.
// Supports importing as active Conclave conversations, or permanently cleaning up from disk.
export function SessionImportSettings() {
  const connected = useCore((s) => s.connection === 'connected')
  const [tab, setTab] = useState<'import' | 'cleanup'>('import')
  const [sessions, setSessions] = useState<ExternalSession[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [agent, setAgent] = useState<'all' | AgentKind>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [hideImported, setHideImported] = useState(true)
  const [busy, setBusy] = useState(false)
  const [imported, setImported] = useState<Conversation[] | null>(null)
  const hideLabel = useId()
  const filterLabel = useId()
  const tabLabel = useId()

  const load = async () => {
    setLoading(true)
    const found = await perform((rpc) => rpc.call('sessionImports.list', {}))
    setLoading(false)
    if (found) {
      setSessions(found.sessions)
      useExternalSessions.setState({ sessions: found.sessions })
    }
  }
  useEffect(() => { if (connected) void load() }, [connected])

  const agents = useMemo(() => [...new Set((sessions ?? []).map((session) => session.agent))], [sessions])
  const needle = query.trim().toLowerCase()
  const visible = (sessions ?? []).filter((session) => (agent === 'all' || session.agent === agent)
    && (tab === 'cleanup' || !hideImported || session.status !== 'imported')
    && (!needle || [session.title, session.firstPrompt, session.cwd].some((text) => text.toLowerCase().includes(needle))))

  // By folder, the folder with the latest session first.
  const byCwd = new Map<string, ExternalSession[]>()
  for (const session of visible) {
    const members = byCwd.get(session.cwd)
    if (members) members.push(session)
    else byCwd.set(session.cwd, [session])
  }
  const groups = [...byCwd]
  const picked = (sessions ?? []).filter((session) => chosen.has(keyOf(session)) && isSelectable(session, tab))
  const isExpanded = (cwd: string) => expanded.get(cwd) ?? Boolean(needle)
  const visibleKeys = new Set(visible.map(keyOf))
  const hiddenPicked = picked.filter((session) => !visibleKeys.has(keyOf(session))).length
  const expandAll = (open: boolean) => setExpanded((current) => {
    const next = new Map(current)
    groups.forEach(([cwd]) => next.set(cwd, open))
    return next
  })

  const toggle = (keys: readonly string[], on: boolean) => setChosen((current) => {
    const next = new Set(current)
    keys.forEach((key) => (on ? next.add(key) : next.delete(key)))
    return next
  })

  const submitImport = async () => {
    if (!picked.length || busy) return
    setBusy(true)
    const completed = new Set<string>()
    const conversations: Conversation[] = []
    try {
      for (let offset = 0; offset < picked.length; offset += 100) {
        const batch = picked.slice(offset, offset + 100)
        const result = await perform((rpc) => rpc.call('sessionImports.import', { sessions: batch.map(({ agent: kind, sessionId }) => ({ agent: kind, sessionId })) }))
        if (!result) break
        conversations.push(...result.conversations)
        batch.forEach((session) => completed.add(keyOf(session)))
      }
    } finally {
      if (completed.size > 0) {
        setImported(conversations)
        setChosen((current) => new Set([...current].filter((key) => !completed.has(key))))
        await load()
      }
      setBusy(false)
    }
  }

  const deleteOne = async (session: ExternalSession) => {
    if (busy) return
    const confirmed = await askConfirm({
      title: t('ConfirmDialog.delete'),
      message: t('SessionImportSettings.deleteConfirm', { title: session.title || session.sessionId }),
      confirmLabel: t('ConfirmDialog.delete'),
      cancelLabel: t('ConfirmDialog.cancel'),
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      await perform((rpc) => rpc.call('sessionImports.delete', { agent: session.agent, sessionId: session.sessionId }))
      setChosen((curr) => {
        const next = new Set(curr)
        next.delete(keyOf(session))
        return next
      })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const deleteFolder = async (cwd: string, members: ExternalSession[]) => {
    if (busy || members.length === 0) return
    const confirmed = await askConfirm({
      title: t('ConfirmDialog.delete'),
      message: t('SessionImportSettings.deleteFolderConfirm', { count: members.length, folder: projectName(cwd) }),
      confirmLabel: t('ConfirmDialog.delete'),
      cancelLabel: t('ConfirmDialog.cancel'),
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      for (const session of members) {
        await perform((rpc) => rpc.call('sessionImports.delete', { agent: session.agent, sessionId: session.sessionId }))
      }
      const memberKeys = new Set(members.map(keyOf))
      setChosen((curr) => new Set([...curr].filter((k) => !memberKeys.has(k))))
      await load()
    } finally {
      setBusy(false)
    }
  }

  const submitDelete = async () => {
    if (!picked.length || busy) return
    const confirmed = await askConfirm({
      title: t('ConfirmDialog.delete'),
      message: t('SessionImportSettings.deleteBatchConfirm', { count: picked.length }),
      confirmLabel: t('ConfirmDialog.delete'),
      cancelLabel: t('ConfirmDialog.cancel'),
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      for (const session of picked) {
        await perform((rpc) => rpc.call('sessionImports.delete', { agent: session.agent, sessionId: session.sessionId }))
      }
      setChosen(new Set())
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!connected) return <p className="settings-empty">{t('ChatCommandSettings.connectToConclaveCoreToView')}</p>
  return (
    <>
      <div className="session-import-tab-bar">
        <span id={tabLabel} hidden>{t('SettingsPage.sessionImport')}</span>
        <Segmented
          labelId={tabLabel}
          value={tab}
          onChange={(v) => {
            setTab(v as 'import' | 'cleanup')
            setChosen(new Set())
          }}
          options={[
            { value: 'import', label: t('SessionImportSettings.tabImport') },
            { value: 'cleanup', label: t('SessionImportSettings.tabCleanup') }
          ]}
        />
      </div>

      <p className="settings-note">
        {tab === 'cleanup' ? t('SessionImportSettings.cleanupNote') : t('SessionImportSettings.note')}
      </p>

      <div className="session-import-toolbar">
        <span id={filterLabel} hidden>{t('SessionImportSettings.agentFilter')}</span>
        {agents.length > 1 && (
          <Segmented labelId={filterLabel} value={agent} onChange={setAgent}
            options={[{ value: 'all', label: t('SessionImportSettings.allAgents') }, ...agents.map((kind) => ({ value: kind, label: agentLabel(kind) }))]} />
        )}
        <input className="input session-import-search" value={query} onChange={(event) => { setQuery(event.target.value); setExpanded(new Map()) }}
          placeholder={t('SessionImportSettings.search')} aria-label={t('SessionImportSettings.search')} />
        {tab === 'import' && (
          <span id={hideLabel} className="session-import-hide">
            {t('SessionImportSettings.hideImported')}
            <Toggle labelId={hideLabel} checked={hideImported} onChange={setHideImported} />
          </span>
        )}
        <button type="button" className="icon-button" disabled={loading} onClick={() => void load()} title={t('SessionImportSettings.rescan')} aria-label={t('SessionImportSettings.rescan')}><RefreshIcon /></button>
      </div>

      {groups.length > 0 && (
        <div className="session-import-list-actions">
          <span className="session-import-summary">{t('SessionImportSettings.summary', { folders: groups.length, count: visible.length })}</span>
          <button type="button" className="button ghost" disabled={groups.every(([cwd]) => isExpanded(cwd))} onClick={() => expandAll(true)}>{t('SessionImportSettings.expandAll')}</button>
          <button type="button" className="button ghost" disabled={groups.every(([cwd]) => !isExpanded(cwd))} onClick={() => expandAll(false)}>{t('SessionImportSettings.collapseAll')}</button>
        </div>
      )}

      {imported && imported.length > 0 && tab === 'import' && (
        <p className="settings-note">
          {t('SessionImportSettings.imported', { count: imported.length })}
          <button type="button" className="button" onClick={() => selectConversation(imported[0]!.id)}>{t('SessionImportSettings.open')}</button>
        </p>
      )}

      {sessions === null ? <p className="settings-empty">{t('SessionImportSettings.scanning')}</p>
        : visible.length === 0 ? <p className="settings-empty">{sessions.length ? t('SessionImportSettings.noneMatch') : t('SessionImportSettings.none')}</p>
          : groups.map(([cwd, members]) => (
            <SessionImportGroup
              key={cwd}
              cwd={cwd}
              members={members}
              chosen={chosen}
              busy={busy}
              tab={tab}
              expanded={isExpanded(cwd)}
              toggle={toggle}
              onExpand={() => setExpanded((current) => new Map(current).set(cwd, !isExpanded(cwd)))}
              onDeleteOne={deleteOne}
              onDeleteFolder={deleteFolder}
            />
          ))}

      <div className="session-import-actions">
        <span className="session-import-summary" aria-live="polite">
          {t('SessionImportSettings.selectedCount', { count: picked.length })}
          {hiddenPicked > 0 && <span> · {t('SessionImportSettings.hiddenSelected', { count: hiddenPicked })}</span>}
        </span>
        {picked.length > 0 && <button type="button" className="button ghost" disabled={busy} onClick={() => setChosen(new Set())}>{t('SessionImportSettings.clearSelection')}</button>}
        {tab === 'import' ? (
          <button type="button" className="button primary" disabled={!picked.length || busy} onClick={() => void submitImport()}>
            {busy ? t('SessionImportSettings.importing') : t('SessionImportSettings.importSelected', { count: picked.length })}
          </button>
        ) : (
          <button type="button" className="button danger" disabled={!picked.length || busy} onClick={() => void submitDelete()}>
            {busy ? t('SessionImportSettings.deleting') : t('SessionImportSettings.deleteSelected', { count: picked.length })}
          </button>
        )}
      </div>
    </>
  )
}

function SessionImportGroup({ cwd, members, chosen, busy, tab, expanded, toggle, onExpand, onDeleteOne, onDeleteFolder }: {
  cwd: string
  members: ExternalSession[]
  chosen: ReadonlySet<string>
  busy: boolean
  tab: 'import' | 'cleanup'
  expanded: boolean
  toggle: (keys: readonly string[], on: boolean) => void
  onExpand: () => void
  onDeleteOne: (session: ExternalSession) => void
  onDeleteFolder: (cwd: string, members: ExternalSession[]) => void
}) {
  const listId = useId()
  const available = members.filter((session) => isSelectable(session, tab)).map(keyOf)
  const selected = available.filter((key) => chosen.has(key)).length
  const all = available.length > 0 && selected === available.length

  return (
    <section className="session-import-group">
      <div className="session-import-folder">
        <input type="checkbox" checked={all} disabled={!available.length || busy} onChange={(event) => toggle(available, event.target.checked)}
          ref={(input) => { if (input) input.indeterminate = selected > 0 && !all }}
          aria-label={t('SessionImportSettings.selectFolder', { value1: projectName(cwd) })} />
        <button type="button" className="session-import-folder-toggle" aria-expanded={expanded} aria-controls={listId} onClick={onExpand}>
          <ChevronRightIcon />
          <span className="settings-project-name">{projectName(cwd)}</span>
          <span className="settings-project-path mono" title={cwd}>{cwd}</span>
          <span className="session-import-count">{t('SessionImportSettings.sessionCount', { count: members.length })}</span>
          {selected > 0 && <span className="session-import-selected">{t('SessionImportSettings.selectedCount', { count: selected })}</span>}
        </button>
        {tab === 'cleanup' && (
          <button
            type="button"
            className="button danger ghost session-import-folder-delete"
            disabled={busy || members.length === 0}
            onClick={(e) => {
              e.stopPropagation()
              onDeleteFolder(cwd, members)
            }}
            title={t('SessionImportSettings.deleteFolder')}
          >
            {t('SessionImportSettings.deleteFolder')}
          </button>
        )}
      </div>
      <ul id={listId} className="settings-project-list" hidden={!expanded}>
        {expanded && members.map((session) => {
          const key = keyOf(session)
          const selectableRow = isSelectable(session, tab)
          return (
            <li key={key} className="settings-project session-import-row">
              <input type="checkbox" checked={chosen.has(key) && selectableRow} disabled={!selectableRow || busy}
                onChange={(event) => toggle([key], event.target.checked)} aria-label={t('SessionImportSettings.select', { value1: session.title })} />
              <span className="session-import-agent" title={agentLabel(session.agent)}><AgentIcon agent={session.agent} /></span>
              <span className="session-import-title" title={session.firstPrompt}>{session.title}</span>
              {session.problem === 'missing-cwd' && <span className="session-import-badge">{t('SessionImportSettings.missingFolder')}</span>}
              {session.status === 'imported' && <span className="session-import-badge">{t('SessionImportSettings.statusImported')}</span>}
              {session.status === 'updated' && <span className="session-import-badge updated">{t('SessionImportSettings.statusUpdated')}</span>}
              <span className="muted session-import-time">{timeAgo(session.updatedAt, Date.now())}</span>
              {session.conversationId && (
                <button type="button" className="button ghost" onClick={() => selectConversation(session.conversationId)}>{t('SessionImportSettings.open')}</button>
              )}
              {tab === 'cleanup' && (
                <button
                  type="button"
                  className="button danger ghost session-import-row-delete"
                  disabled={busy}
                  onClick={() => onDeleteOne(session)}
                  title={t('SessionImportSettings.delete')}
                >
                  {t('SessionImportSettings.delete')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
