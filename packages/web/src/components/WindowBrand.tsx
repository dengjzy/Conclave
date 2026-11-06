import { t } from '../i18n'
import { useEffect } from 'react'
import { setPreference, usePreferences } from '../preferences'
import { hasPrimaryModifier, PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { SidebarIcon } from './icons'

export function toggleSidebar(): void {
  setPreference('sidebarHidden', !usePreferences.getState().sidebarHidden)
}

// Keep the sidebar switch in place whether the sidebar is shown or hidden.
export function WindowBrand() {
  const hidden = usePreferences((s) => s.sidebarHidden)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasPrimaryModifier(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        event.stopPropagation()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  const label = hidden ? t('WindowBrand.expandSidebar') : t('WindowBrand.collapseSidebar')
  return (
    <div className="window-brand">
      <span className="window-brand-name">Conclave</span>
      <button
        type="button"
        className="icon-button window-brand-toggle"
        aria-label={label}
        aria-pressed={!hidden}
        data-tooltip={`${label}（${PRIMARY_KEY_LABEL}B）`}
        data-tooltip-align="start"
        onClick={toggleSidebar}
      >
        <SidebarIcon />
      </button>
    </div>
  )
}
