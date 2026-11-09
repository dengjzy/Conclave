import { t, tr } from '../i18n'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { AgentKind, IMAGE_MIME_TYPES, type TaskImage } from '@conclave/protocol'
import { dismissError, perform, selectTask, setNewTaskOpen, useCore } from '../core-store'
import { defaultAgent } from '../default-agent'
import { useInstalledAgents } from '../installed-agents'
import { PRIMARY_KEY_LABEL, hasPrimaryModifier } from '../shortcut-keys'
import { AgentQuotaHint, useRecommendation } from './AgentQuota'
import { DependencyPicker } from './DependencyPicker'
import { ProjectPicker } from './ProjectPicker'
import { ImageStrip } from './ImageStrip'
import { ImageViewer } from './ImageViewer'
import { imageFilesOf, uploadImageFiles } from '../attachment-images'
import { CloseIcon, MaximizeIcon, MoreIcon, RestoreIcon } from './icons'
import { Popover } from './Popover'
import { ChatPicker } from './ChatPicker'
import { executorOptions } from './TaskExecutorPicker'
import { createDefaultSquad } from '../squads'
import { SquadIcon, AgentIcon } from './icons'
import { MarkdownEditor } from './MarkdownEditor'

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m7.3 11.9 5.2-5.2a2.3 2.3 0 0 1 3.3 3.3l-6.6 6.6a4 4 0 0 1-5.7-5.7l6.7-6.7a1.7 1.7 0 0 1 2.4 2.4l-6.6 6.6" />
    </svg>
  )
}

export function NewTaskDialog() {
  const tasks = useCore((s) => s.tasks)
  const connected = useCore((s) => s.connection === 'connected')
  const error = useCore((s) => s.error)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const ids = useId()
  // Opened on a task already begun (the board's quick add), it goes on from there.
  const [draft] = useState(() => useCore.getState().newTaskDraft)
  const [title, setTitle] = useState(draft?.title ?? '')
  const [repos, setRepos] = useState<string[]>(() => [...(draft?.repos ?? [])])
  const [agent, setAgent] = useState<AgentKind | null>(() => (draft ? draft.agent : defaultAgent(tasks, useCore.getState().conversations)))
  const installed = useInstalledAgents()
  const recommended = useRecommendation(installed)?.agent ?? null
  const squads = useCore((state) => state.squads)
  const [mode, setMode] = useState<'manual' | 'squad'>(() => draft?.mode ?? (draft?.squadId ? 'squad' : (Object.keys(useCore.getState().squads).length > 0 ? 'squad' : 'manual')))
  const [squadId, setSquadId] = useState<string | null>(() => draft?.squadId ?? (draft?.mode === 'manual' ? null : Object.values(useCore.getState().squads).find((s) => s.archivedAt === null)?.id ?? null))
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [details, setDetails] = useState(draft?.details ?? '')
  // The details editor holds its own text; a new key starts it empty for the next task.
  const [detailsKey, setDetailsKey] = useState(0)
  const [images, setImages] = useState<TaskImage[]>([])
  const [uploading, setUploading] = useState(0)
  const [viewing, setViewing] = useState<number | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [createMore, setCreateMore] = useState(false)
  const [lastCreated, setLastCreated] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // State lags a render behind; the ref stops a double press from creating twice.
  const submitting = useRef(false)
  const canSubmit = title.trim() !== '' && connected && !busy && uploading === 0

  // Images go up as soon as they are added; the task only names them on creation.
  const addImages = async (files: File[]) => {
    setUploading((count) => count + files.length)
    const added = await uploadImageFiles(files)
    setUploading((count) => count - files.length)
    setImages((current) => [...current, ...added.filter((image) => !current.some((each) => each.id === image.id))])
  }

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
    }
    // showModal focuses the first focusable element (the close button); React's
    // autoFocus never sets the attribute it would honor instead.
    titleInput.current?.focus()
    dismissError()
    return () => element?.close()
  }, [])

  const close = () => setNewTaskOpen(false)

  async function submit() {
    if (!canSubmit || submitting.current) {
      return
    }
    submitting.current = true
    setBusy(true)
    dismissError()
    const task = await perform((rpc) =>
      rpc.call('tasks.create', {
        title: title.trim(),
        details: details.trim() ? details : undefined,
        repos,
        dependsOn,
        agent,
        ...(squadId ? { squadId } : {}),
        images: images.map(({ id, name }) => ({ id, name }))
      })
    )
    submitting.current = false
    setBusy(false)
    if (!task) {
      return
    }
    if (createMore) {
      // Keep repos and agent: a batch of tasks usually shares them.
      setTitle('')
      setDetails('')
      setDetailsKey((key) => key + 1)
      setDependsOn([])
      setImages([])
      setLastCreated(task.title)
      titleInput.current?.focus()
    } else {
      selectTask(task.id)
      close()
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && hasPrimaryModifier(event)) {
      event.preventDefault()
      void submit()
    }
  }

  // The dialog element itself is only hit on the backdrop; its content fills it.
  const onBackdrop = (event: MouseEvent) => {
    if (event.target === dialog.current) {
      close()
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal new-task-dialog"
      data-expanded={expanded || undefined}
      aria-labelledby={`${ids}-heading`}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onKeyDown={onKeyDown}
      onClick={onBackdrop}
      onPaste={(event) => {
        const files = imageFilesOf(event.clipboardData)
        if (files.length > 0) {
          event.preventDefault()
          void addImages(files)
        }
      }}
      onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()}
      onDrop={(event) => {
        const files = imageFilesOf(event.dataTransfer)
        if (files.length > 0) {
          event.preventDefault()
          void addImages(files)
        }
      }}
    >
      <div className="modal-body new-task-body">
        <header className="new-task-header">
          <div className="new-task-breadcrumb">
            <span>Conclave</span>
            <span className="new-task-breadcrumb-separator" aria-hidden="true">›</span>
            <h2 id={`${ids}-heading`}>{t('NewTaskDialog.createdManually')}</h2>
          </div>
          <div className="new-task-window-actions">
            <button type="button" className="icon-button" aria-label={expanded ? t('NewTaskDialog.restoreWindow') : t('NewTaskDialog.expandWindow')} onClick={() => setExpanded((value) => !value)}>
              {expanded ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            <button type="button" className="icon-button" aria-label={t('BackdropPicker.close')} onClick={close}>
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="new-task-editor">
          <input
            ref={titleInput}
            className="new-task-title"
            aria-label={t('NewTaskDialog.taskTitle')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // ⌘↵ is handled by the dialog; composing Enter only commits the IME input.
              if (e.key === 'Enter' && !hasPrimaryModifier(e) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={t('NewTaskDialog.taskTitle')}
            maxLength={200}
          />
          <MarkdownEditor
            key={detailsKey}
            className="new-task-details"
            value={details}
            onChange={setDetails}
            onSubmit={() => void submit()}
            label={t('NewTaskDialog.taskDetails')}
            hint={t('NewTaskDialog.addDetailsMarkdownSupported')}
          />
        </div>

        {(images.length > 0 || uploading > 0) && (
          <div className="new-task-images">
            <ImageStrip
              images={images}
              uploading={uploading}
              onOpen={setViewing}
              onRemove={(id) => setImages((current) => current.filter((image) => image.id !== id))}
            />
          </div>
        )}

        
        <div className="new-task-mode-selector" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px', background: 'var(--color-bg-secondary, rgba(255,255,255,0.03))', borderRadius: '8px', border: '1px solid var(--color-border-subtle, rgba(255,255,255,0.08))', margin: '0 0 12px 0' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary, #888)' }}>{t('NewTaskDialog.executionMode')}:</span>
            <button
              type="button"
              className={`button ${mode === 'squad' ? 'primary' : 'ghost'}`}
              style={{ padding: '4px 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              onClick={() => {
                setMode('squad')
                if (!squadId) {
                  const firstSquad = Object.values(squads).find((s) => s.archivedAt === null)
                  if (firstSquad) setSquadId(firstSquad.id)
                }
              }}
            >
              <SquadIcon />
              {t('NewTaskDialog.modeSquad')}
            </button>
            <button
              type="button"
              className={`button ${mode === 'manual' ? 'primary' : 'ghost'}`}
              style={{ padding: '4px 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              onClick={() => {
                setMode('manual')
                setSquadId(null)
              }}
            >
              <AgentIcon agent={agent ?? 'claude'} />
              {t('NewTaskDialog.modeManual')}
            </button>
          </div>
          {mode === 'squad' ? (
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted, #999)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div>{t('NewTaskDialog.squadAutoHint')}</div>
              <div style={{ padding: '6px 8px', background: 'var(--color-bg-tertiary, rgba(255,255,255,0.02))', borderRadius: '4px', borderLeft: '3px solid var(--color-accent, #3b82f6)' }}>
                {t('NewTaskDialog.pipelineRoles')}
              </div>
              {Object.keys(squads).filter((id) => squads[id]?.archivedAt === null).length === 0 && (
                <div style={{ marginTop: '4px' }}>
                  <button
                    type="button"
                    className="button secondary"
                    style={{ fontSize: '11px', padding: '3px 8px' }}
                    onClick={async () => {
                      const created = await createDefaultSquad(installed)
                      if (created) setSquadId(created.id)
                    }}
                  >
                    + {t('NewTaskDialog.createDefaultSquad')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted, #999)' }}>
              {t('NewTaskDialog.manualSingleHint')}
            </div>
          )}
        </div>

        <div className="new-task-properties">
          <ProjectPicker
            projects={repos.map((repoPath) => ({ path: repoPath, worktreePath: null }))}
            onChange={setRepos}
            compact
          />
          <span className="new-task-agent-chip">
            <ChatPicker
              label={t('NewTaskDialog.assignee')}
              value={squadId ? `squad:${squadId}` : agent ?? ''}
              placeholder={squadId ? t('NewTaskDialog.developmentSquad') : t('AgentPicker.chooseAgent')}
              options={executorOptions(installed, squads, squadId, recommended)}
              size="large"
              placement="below"
              onChange={(value) => {
                if (value.startsWith('squad:')) { setSquadId(value.slice(6)); return }
                setSquadId(null)
                const parsed = AgentKind.safeParse(value)
                setAgent(parsed.success ? parsed.data : null)
              }}
            />
          </span>
          <span className="menu-anchor">
            <button type="button" className="new-task-property-chip" aria-label={t('NewTaskDialog.moreOptions')} aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
              <MoreIcon />
            </button>
            {moreOpen && (
              <Popover label={t('NewTaskDialog.moreTaskOptions')} onClose={() => setMoreOpen(false)}>
                <div className="new-task-more-content">
                  <span className="modal-label">{t('NewTaskDialog.dependencies')}</span>
                  <DependencyPicker taskId={null} dependsOn={dependsOn} onChange={setDependsOn} />
                  {agent && <AgentQuotaHint agent={agent} />}
                </div>
              </Popover>
            )}
          </span>
          {dependsOn.length > 0 && <span className="new-task-dependency-count">{tr('NewTaskDialog.dependencies_1266', { value1: dependsOn.length })}</span>}
        </div>
        {viewing !== null && images.length > 0 && (
          <ImageViewer
            images={images}
            index={Math.min(viewing, images.length - 1)}
            onIndex={setViewing}
            onClose={() => setViewing(null)}
            onRename={(id, name) => setImages((current) => current.map((image) => (image.id === id ? { ...image, name } : image)))}
          />
        )}

        {/* The app's toast renders below the modal's top layer, so errors show here instead. */}
        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}

        <footer className="modal-footer new-task-footer">
          <button type="button" className="new-task-attach" aria-label={t('ChatImages.addImages')} title={t('NewTaskDialog.addImagesOrPasteOrDragThemHere')} onClick={() => imageInput.current?.click()}>
            <PaperclipIcon />
          </button>
          <input
            ref={imageInput}
            type="file"
            hidden
            multiple
            accept={IMAGE_MIME_TYPES.join(',')}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              if (files.length > 0) void addImages(files)
            }}
          />
          <span className="new-task-footer-spacer" />
          <label className="switch">{tr('NewTaskDialog.createMore', { value1: <input type="checkbox" role="switch" checked={createMore} onChange={(e) => setCreateMore(e.target.checked)} />, value2: <span className="switch-track" aria-hidden="true" /> })}</label>
          {createMore && lastCreated && <span className="muted modal-created">{tr('NewTaskDialog.created', { lastCreated: lastCreated })}</span>}
          <button type="button" className="button primary modal-submit" disabled={!canSubmit} onClick={() => void submit()}>{tr('NewTaskDialog.createTask', { value1: <kbd>{PRIMARY_KEY_LABEL}↵</kbd> })}</button>
        </footer>
      </div>
    </dialog>
  )
}
