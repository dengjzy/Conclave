import { t } from '../i18n'
import { tasksWaitingOnUser } from '../attention'
import { selectTask, setNewTaskOpen, useActionableItems, useCore, useTaskBoardOpen } from '../core-store'
import { IS_MAC } from '../shortcut-keys'
import { activeInboxes } from '../source-inboxes'
import { CountBadge } from './CountBadge'
import { BoardIcon, PlusIcon } from './icons'

// Single unified sidebar entry for the Agenda workbench (local items, external trackers, and self-evolution).
export function SidebarTasks() {
  const boardOpen = useTaskBoardOpen()
  const inboxOpen = useCore((s) => s.inboxOpen)
  const sources = useCore((s) => s.sources)
  const inboxes = useCore((s) => s.inboxes)
  const open = boardOpen || inboxOpen
  const waitingTasks = tasksWaitingOnUser(useActionableItems())
  const active = activeInboxes(sources, inboxes)
  const remoteWaiting = active.reduce((sum, entry) => sum + entry.inbox.items.length, 0)
  const syncFailed = active.some((entry) => entry.inbox.problem !== null)
  const totalBadge = waitingTasks + remoteWaiting

  return (
    <nav className="sidebar-tasks" aria-label={t('sidebar.tasks')}>
      <div className="sidebar-tasks-entry">
        <button
          type="button"
          className="inbox-entry"
          aria-current={open}
          aria-label={t('SidebarTasks.tasks', {
            value1: totalBadge ? t('SidebarTasks.needYourResponse', { waiting: totalBadge }) : ''
          })}
          onClick={() => selectTask(null)}
        >
          <BoardIcon />
          <span>{t('sidebar.tasks')}</span>
          {syncFailed ? (
            <span className="inbox-entry-alert" title={t('SourceInboxView.syncFailed')}>!</span>
          ) : (
            <CountBadge count={totalBadge} title={t('SidebarTasks.tasksNeedYourResponse', { waiting: totalBadge })} />
          )}
        </button>
        <button
          type="button"
          className="icon-button sidebar-tasks-add sidebar-add"
          aria-label={t('SettingsPage.newTask')}
          data-tooltip={t('SidebarTasks.newTaskN', { PRIMARY_KEY_LABEL: IS_MAC ? '⌘' : 'Alt+' })}
          onClick={() => setNewTaskOpen(true)}
        >
          <PlusIcon />
        </button>
      </div>
    </nav>
  )
}
