import { useCallback, useRef, useState } from 'react'
import { openNewConversationDraft, setSettingsOpen, switchConversationDraftMode, useDiscussionsSupported, useSessionImportSupported, type ConversationDraftMode } from '../core-store'
import { t } from '../i18n'
import { ChatPicker } from './ChatPicker'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { PlusIcon } from './icons'
import './conversation-create.css'

export function conversationModeLabel(mode: ConversationDraftMode): string {
  return t(mode === 'single' ? 'ConversationModes.single' : mode === 'fanout' ? 'ConversationModes.fanout' : 'ConversationModes.debate')
}

const MODES = ['single', 'fanout', 'debate'] as const

export function ConversationCreateMenu({ projects, className = 'icon-button task-list-add sidebar-add', label = t('ConversationDraft.newConversation') }: { projects?: readonly string[]; className?: string; label?: string }) {
  const supported = useDiscussionsSupported()
  const sessionImportSupported = useSessionImportSupported()
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  return <>
    <button
      ref={button}
      type="button"
      className={className}
      aria-label={label}
      data-tooltip={label}
      aria-haspopup="menu"
      aria-expanded={at !== null}
      onClick={() => {
        openNewConversationDraft('single', projects)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        const box = event.currentTarget.getBoundingClientRect()
        setAt((current) => current ? null : { x: box.right, y: box.bottom + 4 })
      }}
    ><PlusIcon /></button>
    {at && <ContextMenu at={at} align="end" trigger={button.current} label={t('ConversationDraft.newConversation')} onClose={close}>
      {MODES.filter((mode) => mode === 'single' || supported).map((mode) => <MenuItem key={mode} label={conversationModeLabel(mode)} onSelect={() => { close(); openNewConversationDraft(mode, projects) }} />)}
      {sessionImportSupported && <MenuItem label={t('SettingsPage.sessionImport')} onSelect={() => { close(); setSettingsOpen(true, 'session-import') }} />}
    </ContextMenu>}
  </>
}

export function ConversationModePicker({ mode, disabled = false }: { mode: ConversationDraftMode; disabled?: boolean }) {
  const supported = useDiscussionsSupported()
  return <ChatPicker label={t('ConversationModes.type')} value={mode} placeholder="" disabled={disabled} options={MODES.filter((each) => each === 'single' || supported).map((each) => ({ value: each, label: conversationModeLabel(each) }))} onChange={(value) => {
    const next = MODES.find((each) => each === value)
    if (next) switchConversationDraftMode(next)
  }} />
}
