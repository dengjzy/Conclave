import { t } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { ResolvedFile } from '@conclave/protocol'
import { showError } from '../core-store'
import { canOpenFile, canRevealFile, installedOpenWithApps, openWith, type OpenWithApp } from '../desktop-bridge'
import { FILE_MANAGER, openResolvedFile, revealResolvedFile } from '../file-actions'
import { setPreference, usePreferences } from '../preferences'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { ChevronDownIcon, ExternalIcon, FolderIcon } from './icons'

function AppIcon({ app }: { app: OpenWithApp }) {
  return app.icon ? <img className="open-with-icon" src={app.icon} alt="" /> : <ExternalIcon />
}

// Opens the file in the app last picked, or another from the menu beside it: the editors and
// terminals installed here, the system's default app and the file manager.
export function OpenWithButton({ file }: { file: ResolvedFile }) {
  const [apps, setApps] = useState<OpenWithApp[]>([])
  const [menu, setMenu] = useState<MenuPoint | null>(null)
  const more = useRef<HTMLButtonElement>(null)
  const picked = usePreferences((preferences) => preferences.openWithApp)
  useEffect(() => {
    let current = true
    void installedOpenWithApps().then((found) => { if (current) setApps(found) })
    return () => { current = false }
  }, [])
  // The app picked last; before any, the first editor; with none, the default app.
  const chosen = apps.find((app) => app.id === picked) ?? apps.find((app) => app.kind === 'editor') ?? null
  const open = async (app: OpenWithApp) => {
    setPreference('openWithApp', app.id)
    const error = await openWith(file.path, app.id)
    if (error) showError(error)
  }
  const close = () => setMenu(null)
  const label = chosen ? t('OpenWithButton.openWith', { value1: chosen.id === 'terminal' ? t('SettingsPage.terminal') : chosen.name }) : t('OpenWithButton.openWithDefaultApp')
  return <span className="open-with">
    <button type="button" className="tool-button open-with-main" aria-label={label} title={label} disabled={!chosen && !canOpenFile()}
      onClick={() => void (chosen ? open(chosen) : openResolvedFile(file))}>
      {chosen ? <AppIcon app={chosen} /> : <ExternalIcon />}
      <span className="open-with-name">{chosen ? chosen.id === 'terminal' ? t('SettingsPage.terminal') : chosen.name : t('ChatBrowserCard.open')}</span>
    </button>
    <button type="button" className="tool-button open-with-more" ref={more} aria-label={t('OpenWithButton.openWithAnotherApp')} title={t('OpenWithButton.openWithAnotherApp')} aria-haspopup="menu" aria-expanded={menu !== null}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenu((menu) => menu ? null : { x: bounds.right, y: bounds.bottom + 4 })
      }}>
      <ChevronDownIcon />
    </button>
    {menu && <ContextMenu at={menu} align="end" trigger={more.current} label={t('OpenWithButton.openWithAnotherApp')} onClose={close}>
      {apps.map((app) => <MenuItem key={app.id} label={app.id === 'terminal' ? t('SettingsPage.terminal') : app.name} icon={<AppIcon app={app} />} onSelect={() => { close(); void open(app) }} />)}
      {apps.length > 0 && <div className="menu-separator" role="separator" />}
      {canOpenFile() && <MenuItem label={t('OpenWithButton.openWithDefaultApp')} icon={<ExternalIcon />} onSelect={() => { close(); void openResolvedFile(file) }} />}
      {canRevealFile() && <MenuItem label={t('FileMenu.showIn', { FILE_MANAGER: FILE_MANAGER() })} icon={<FolderIcon />} onSelect={() => { close(); void revealResolvedFile(file) }} />}
    </ContextMenu>}
  </span>
}
