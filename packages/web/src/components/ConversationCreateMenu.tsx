import { useCallback, useRef, useState } from 'react'
import { openNewConversationDraft, setNewTaskOpen, setSettingsOpen, useCore, useSessionImportSupported } from '../core-store'
import { t } from '../i18n'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { PlusIcon } from './icons'
import './conversation-create.css'

export function ConversationCreateMenu({ projects, className = 'icon-button task-list-add sidebar-add', label = t('ConversationDraft.newConversation') }: { projects?: readonly string[]; className?: string; label?: string }) {
  const sessionImportSupported = useSessionImportSupported()
  const flowsSupported = useCore((state) => state.rpc?.features.includes('flows') ?? false)
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
        openNewConversationDraft(projects)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        const box = event.currentTarget.getBoundingClientRect()
        setAt((current) => current ? null : { x: box.right, y: box.bottom + 4 })
      }}
    ><PlusIcon /></button>
    {at && <ContextMenu at={at} align="end" trigger={button.current} label={t('ConversationDraft.newConversation')} onClose={close}>
      <MenuItem label={t('ConversationModes.single')} onSelect={() => { close(); openNewConversationDraft(projects) }} />
      {flowsSupported && <MenuItem label={t('ConversationDraft.autonomousTask')} onSelect={() => { close(); setNewTaskOpen(true) }} />}
      {sessionImportSupported && <MenuItem label={t('SettingsPage.sessionImport')} onSelect={() => { close(); setSettingsOpen(true, 'session-import') }} />}
    </ContextMenu>}
  </>
}
