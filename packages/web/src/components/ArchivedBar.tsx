import { t, tr } from '../i18n'
import { useState } from 'react'

// Where an archived chat's input was: it is read-only, and this is the way back.
export function ArchivedBar({ what, onRestore }: { what: string; onRestore: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const restore = async () => {
    setBusy(true)
    await onRestore()
    setBusy(false)
  }
  return (
    <div className="chat-archived" role="status">
      <span className="chat-archived-note">{tr('ArchivedBar.thisIsArchivedAndCanOnlyBeViewed', { what: what })}</span>
      <button type="button" className="button" disabled={busy} onClick={() => void restore()}>{t('ArchivedBar.unarchive')}</button>
    </div>
  )
}
