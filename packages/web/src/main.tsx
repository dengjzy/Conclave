import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist-mono/wght.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { startAppearance } from './appearance'
import { startBackgroundRest } from './background-rest'
import { startCodeFont } from './code-font'
import { startCoreConnection, useCore } from './core-store'
import { SettingsPage } from './components/SettingsPage'
import { startNotifications } from './notifications'
import { followPreferences } from './preferences'
import { startUnsavedEditRetries } from './unsaved-edits'
import { startUiLanguage } from './language'
import { startWorktreeUpdates } from './worktree-store'

const settingsPreview = import.meta.env.DEV && location.hash === '#settings'
if (settingsPreview) useCore.setState({ settingsOpen: true, settingsSection: 'appearance' })

startUiLanguage()
followPreferences()

// Outside React so StrictMode's double-mount can't start two loops.
startCoreConnection()
startAppearance()
startBackgroundRest()
startCodeFont()
startUnsavedEditRetries()
startWorktreeUpdates()
startNotifications()

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root')
}
createRoot(root).render(
  <StrictMode>
    {settingsPreview ? <div className="app"><SettingsPage /></div> : <App />}
  </StrictMode>
)
