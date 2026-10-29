import { t } from '../i18n'
import { setInboxOpen, useCore } from '../core-store'
import { CountBadge } from './CountBadge'
import { InboxIcon } from './icons'

// The way to the inbox, at the top of the sidebar beside the overview: an issue may become a task
// or be looked into in a conversation, so it belongs to neither list. Shown once a source is set up
// and signed in; a failed sync shows in place of the count.
export function InboxEntry() {
  const open = useCore((s) => s.inboxOpen)
  const inboxes = useCore((s) => s.inboxes)
  const active = Object.values(inboxes).filter((inbox) => inbox.active)
  if (active.length === 0) return null
  const waiting = active.reduce((sum, inbox) => sum + inbox.items.length, 0)
  const failed = active.some((inbox) => inbox.problem)
  return (
    <button type="button" className="inbox-entry" aria-current={open}
      aria-label={t('InboxEntry.inbox', { value1: failed ? t('InboxEntry.syncFailed') : waiting ? t('InboxEntry.pending', { waiting: waiting }) : '' })} onClick={() => setInboxOpen(true)}>
      <InboxIcon />
      <span>{t('InboxEntry.inbox_1125')}</span>
      {failed
        ? <span className="inbox-entry-alert" aria-hidden="true">!</span>
        : <CountBadge count={waiting} />}
    </button>
  )
}
