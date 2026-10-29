import { useState } from 'react'
import type { UpdateState } from '../shared/app-update'
import { t } from '../i18n'
import { checkForUpdate, installUpdate, setUpdateAutomatic, setUpdatePrerelease, skipUpdate, updateOffered, useUpdate } from '../update-state'
import { closeTerminal, selectConversation, showTerminal, useCore } from '../core-store'
import { agentLabel } from '../labels'
import { ArrowUpIcon, ChevronDownIcon } from './icons'
import { ChatMarkdown } from './ChatMarkdown'
import { Popover } from './Popover'
import { SettingsRow, Toggle } from './SettingsControls'

const ERROR_TEXT: Record<string, () => string> = {
  'download-failed': () => t('AppUpdate.errorDownload'),
  incomplete: () => t('AppUpdate.errorIncomplete'),
  'digest-mismatch': () => t('AppUpdate.errorDigest'),
  'wrong-app': () => t('AppUpdate.errorBadInstaller'),
  'wrong-version': () => t('AppUpdate.errorBadInstaller'),
  'no-app-in-dmg': () => t('AppUpdate.errorBadInstaller'),
  'agents-running': () => t('AppUpdate.errorAgentsRunning'),
  'backend-unresponsive': () => t('AppUpdate.errorBackendUnresponsive')
}

export function updateErrorText(error: string): string {
  // Chromium's own network errors (net::ERR_CONNECTION_TIMED_OUT and the like) all mean GitHub was out of reach.
  if (error.startsWith('net::')) return t('AppUpdate.errorNetwork')
  if (error === 'GitHub 403' || error === 'GitHub 429') return t('AppUpdate.errorRateLimited')
  return ERROR_TEXT[error]?.() ?? error
}

const isMac = () => window.conclave?.platform === 'darwin'

// What kept the update from installing, each named as the app shows it, with what to do about it.
function InstallBlockers({ blockers }: { blockers: UpdateState['blockers'] }) {
  const terminals = useCore((s) => s.terminals)
  const conversations = useCore((s) => s.conversations)
  if (blockers.length === 0) return null
  return (
    <ul className="update-blockers">
      {blockers.map(({ sessionId, agent }) => {
        const terminal = terminals.find((each) => each.sessionId === sessionId)
        if (terminal) return (
          <li key={sessionId}>
            <span className="update-blocker-label">{t('AppUpdate.blockerTerminal', { title: terminal.title })}</span>
            <button type="button" className="button" onClick={() => showTerminal(terminal.id)}>{t('AppUpdate.open')}</button>
            {!terminal.conversationId && <button type="button" className="button" onClick={() => closeTerminal(terminal.id)}>{t('AppUpdate.closeTerminal')}</button>}
          </li>
        )
        const conversation = Object.values(conversations).find((each) => each.sessionId === sessionId)
        if (conversation) return (
          <li key={sessionId}>
            <span className="update-blocker-label">{t('AppUpdate.blockerConversation', { title: conversation.title })}</span>
            <button type="button" className="button" onClick={() => selectConversation(conversation.id)}>{t('AppUpdate.open')}</button>
          </li>
        )
        return <li key={sessionId}><span className="update-blocker-label">{agent ? t('AppUpdate.blockerAgent', { agent: agentLabel(agent) }) : t('AppUpdate.blockerUnknown')}</span></li>
      })}
    </ul>
  )
}

// What can be done about the newer version: install it in place where main can, else fetch the
// installer; the release page and skipping either way.
export function UpdateActions({ state, onSkip }: { state: UpdateState; onSkip?: () => void }) {
  const latest = state.latest
  if (!latest) return null
  if (state.status === 'downloading') {
    const percent = Math.round((state.progress ?? 0) * 100)
    return (
      <div className="update-progress" role="status">
        <span>{t('AppUpdate.downloading', { percent })}</span>
        <progress max={100} value={percent} />
      </div>
    )
  }
  if (state.status === 'installing') return <div className="update-progress" role="status">{t('AppUpdate.installing')}</div>
  const failedInstall = state.status === 'error' && state.canInstall
  return (
    <>
      {state.status === 'ready' && state.automatic && <p className="update-hint" role="status">{t('AppUpdate.installOnNextLaunch')}</p>}
      {state.error && state.status === 'error' && <p className="update-error">{t('AppUpdate.failed', { reason: updateErrorText(state.error) })}</p>}
      {state.status === 'error' && <InstallBlockers blockers={state.blockers} />}
      {!state.canInstall && <p className="update-hint">{isMac() ? t('AppUpdate.manualMac') : t('AppUpdate.manualWindows')}</p>}
      <div className="update-actions">
        {state.canInstall ? (
          <button type="button" className="button primary" onClick={installUpdate}>{failedInstall ? t('AppUpdate.retry') : state.status === 'ready' ? t('AppUpdate.installDownloaded') : t('AppUpdate.installAndRestart')}</button>
        ) : (
          latest.download && <a className="button primary" href={latest.download} target="_blank" rel="noreferrer">{t('AppUpdate.downloadInstaller')}</a>
        )}
        <a className="button" href={latest.page} target="_blank" rel="noreferrer">{t('AppUpdate.releasePage')}</a>
        {onSkip && <button type="button" className="button update-skip" onClick={onSkip}>{t('AppUpdate.skipVersion')}</button>}
      </div>
      {state.canInstall && <p className="update-hint">{isMac() ? t('AppUpdate.restartNote') : t('AppUpdate.restartNoteWindows')}</p>}
    </>
  )
}

// A newer Conclave, in the status bar until it is installed or skipped.
export function UpdateButton() {
  const state = useUpdate((s) => s.state)
  const [open, setOpen] = useState(false)
  if (!state?.latest || !updateOffered(state)) return null
  const { latest } = state
  const busy = state.status === 'downloading' || state.status === 'installing'
  const ready = state.status === 'ready' && state.canInstall
  const label = ready ? t('AppUpdate.installDownloaded')
    : state.status === 'downloading' ? t('AppUpdate.downloading', { percent: Math.round((state.progress ?? 0) * 100) })
    : state.status === 'installing' ? t('AppUpdate.installing')
    : t('AppUpdate.newVersion', { version: latest.version })
  return (
    <span className="menu-anchor statusbar-update-anchor">
      <button
        type="button"
        className="tool-button statusbar-update"
        aria-haspopup={ready ? undefined : "dialog"}
        aria-expanded={ready ? undefined : open}
        disabled={state.status === 'installing'}
        title={ready ? t('AppUpdate.available', { version: latest.version }) : undefined}
        data-busy={busy || undefined}
        onClick={ready ? installUpdate : () => setOpen((value) => !value)}
      >
        <ArrowUpIcon />
        <span>{label}</span>
      </button>
      {ready && (
        <button
          type="button"
          className="tool-button statusbar-update"
          aria-label={t('AppUpdate.details')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDownIcon />
        </button>
      )}
      {open && (
        <Popover label={t('AppUpdate.available', { version: latest.version })} onClose={() => setOpen(false)}>
          <div className="update-card">
            <div className="update-title">{t('AppUpdate.available', { version: latest.version })}</div>
            <div className="update-current">{t('AppUpdate.current', { version: state.current })}</div>
            {latest.notes.trim() && <div className="update-notes"><ChatMarkdown text={latest.notes} highlight={false} /></div>}
            <UpdateActions state={state} onSkip={() => { skipUpdate(latest.version); setOpen(false) }} />
          </div>
        </Popover>
      )}
    </span>
  )
}

function statusText(state: UpdateState): string {
  if (state.status === 'checking') return t('AppUpdate.checking')
  if (state.status === 'error' && !state.latest && state.error) return t('AppUpdate.checkFailed', { reason: updateErrorText(state.error) })
  if (state.latest && state.latest.version === state.skipped) return t('AppUpdate.skipped', { version: state.latest.version })
  if (state.latest) return t('AppUpdate.available', { version: state.latest.version })
  if (state.status === 'none') return t('AppUpdate.upToDate')
  return ''
}

// Under 关于: where the app stands against the latest release, a check on demand, and whether
// pre-releases count.
export function UpdateSettings() {
  const [savingAutomatic, setSavingAutomatic] = useState(false)
  const [automaticError, setAutomaticError] = useState(false)
  const changeAutomatic = async (value: boolean) => {
    setSavingAutomatic(true)
    setAutomaticError(false)
    try { await setUpdateAutomatic(value) }
    catch { setAutomaticError(true) }
    finally { setSavingAutomatic(false) }
  }
  const state = useUpdate((s) => s.state)
  if (!state) return null
  const skipped = state.latest !== null && state.latest.version === state.skipped
  const checked = state.checkedAt === null ? null : new Date(state.checkedAt).toLocaleString()
  return (
    <>
      <SettingsRow
        label={t('AppUpdate.updates')}
        description={[t('AppUpdate.updatesDescription'), checked && t('AppUpdate.lastChecked', { time: checked })].filter(Boolean).join(' ')}
        control={() => (
          <span className="update-settings-status">
            <span className="muted">{statusText(state)}</span>
            {skipped && <button type="button" className="button" onClick={() => skipUpdate(null)}>{t('AppUpdate.unskip')}</button>}
            <button type="button" className="button" disabled={state.status === 'checking' || state.status === 'downloading' || state.status === 'installing'} onClick={checkForUpdate}>{t('AppUpdate.checkNow')}</button>
          </span>
        )}
      />
      {state.latest && !skipped && (
        <div className="update-settings-actions">
          <UpdateActions state={state} />
        </div>
      )}
      <SettingsRow
        label={t('AppUpdate.automatic')}
        description={t('AppUpdate.automaticDescription')}
        control={(labelId) => <Toggle labelId={labelId} checked={state.automatic} disabled={savingAutomatic || state.status === 'installing' || !window.conclave?.setUpdateAutomatic} onChange={(value) => void changeAutomatic(value)} />}
      />
      {automaticError && <p className="update-error" role="alert">{t('AppUpdate.automaticSaveFailed')}</p>}
      <SettingsRow
        label={t('AppUpdate.prerelease')}
        description={t('AppUpdate.prereleaseDescription')}
        control={(labelId) => <Toggle labelId={labelId} checked={state.prerelease} onChange={setUpdatePrerelease} />}
      />
    </>
  )
}
