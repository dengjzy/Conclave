import type { ReactNode } from 'react'
import { t } from '../i18n'
import { ArrowLeftIcon, CloseIcon } from './icons'

export function AgentsPageHeader({ title, description, back, actions, onClose }: {
  title: string
  description?: ReactNode
  back?: { label: string; onClick(): void }
  actions?: ReactNode
  onClose?: () => void
}) {
  return (
    <header className="worktrees-header agents-page-header">
      {back && (
        <button type="button" className="tool-button" aria-label={back.label} data-tooltip={back.label} onClick={back.onClick}>
          <ArrowLeftIcon />
        </button>
      )}
      <div className="worktrees-heading">
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      {(actions || onClose) && (
        <div className="agents-page-header-actions">
          {actions}
          {onClose && (
            <button type="button" className="tool-button" aria-label={t('BackdropPicker.close')} data-tooltip={t('BackdropPicker.close')} onClick={onClose}>
              <CloseIcon />
            </button>
          )}
        </div>
      )}
    </header>
  )
}

