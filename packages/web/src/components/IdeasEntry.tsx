import { t } from '../i18n'
import { setIdeasOpen, useCore } from '../core-store'
import { SparkIcon } from './icons'

export function IdeasEntry() {
  const open = useCore((state) => state.ideasOpen)
  return <nav className="sidebar-tasks" aria-label={t('Ideas.title')}>
    <div className="sidebar-tasks-entry">
      <button type="button" className="inbox-entry" aria-current={open} onClick={() => setIdeasOpen(true)}>
        <SparkIcon />
        <span>{t('Ideas.title')}</span>
      </button>
    </div>
  </nav>
}
