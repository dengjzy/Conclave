import { useEffect, useRef, useState } from 'react'
import type { RemoteAccessStatus, RemoteInvitation, RpcConnection } from '@conclave/protocol'
import { useOccludesBrowser } from '../browser-occlusion'
import { perform, useCore } from '../core-store'
import { getLocale, t } from '../i18n'
import { CopyButton } from './CopyButton'
import { CloseIcon } from './icons'
import { SettingsGroup, SettingsRow, Toggle } from './SettingsControls'
import './remote-settings.css'

type Invitation = RemoteInvitation
type Snapshot = { connection: RpcConnection; status: RemoteAccessStatus }

function RemoteClientEntry() {
  return <SettingsGroup>
    <SettingsRow label={t('RemoteSettings.client')} description={t('RemoteSettings.clientHint')}
      control={() => <a className="button" href="/conclave?node=connect" target="_blank" rel="noopener noreferrer">{t('RemoteSettings.openClient')}</a>} />
  </SettingsGroup>
}

export function RemoteSettingsPanel({ status, busy, onToggle, onInvite, onRevoke, onWebToggle }: {
  status: RemoteAccessStatus
  busy: boolean
  onToggle(enabled: boolean): void
  onInvite(): void
  onRevoke(id: string): void
  onWebToggle?(enabled: boolean): void
}) {
  if (!status.supported) return <><RemoteClientEntry /><p className="remote-note" role="status">{t('RemoteSettings.unsupported')}</p></>
  const enabled = status.state === 'preparing' || status.state === 'starting' || status.state === 'ready'
  const devices = status.devices
  const webState = status.webState ?? (status.clientUrl ? 'ready' : 'disabled')
  return <>
    <RemoteClientEntry />
    <SettingsGroup>
      <SettingsRow label={t('RemoteSettings.enabled')} description={<span role="status">{t(`RemoteSettings.state.${status.state}`)}</span>}
        control={(labelId) => <Toggle labelId={labelId} checked={enabled} disabled={busy} onChange={onToggle} />} />
      {status.state === 'error' && <div className="remote-problem">
        <p role="alert">{status.problem || t('RemoteSettings.failed')}</p>
        <button type="button" className="button" disabled={busy} onClick={() => onToggle(true)}>{t('ChatContextMenu.retry')}</button>
      </div>}
      {status.state === 'ready' && <SettingsRow label={t('RemoteSettings.addPhone')} description={t(status.clientUrl ? 'RemoteSettings.scanHint' : 'RemoteSettings.appOnlyHint')}
        control={() => <button type="button" className="button primary" disabled={busy} onClick={onInvite}>{t('RemoteSettings.addPhone')}</button>} />}
      {status.state === 'ready' && <SettingsRow label={t('RemoteSettings.webEntry')}
        description={<span role="status">{t(`RemoteSettings.web.${webState}`)}</span>}
        control={() => <span className="remote-web-actions">
          {status.clientUrl && <><a className="button" href={status.clientUrl} target="_blank" rel="noopener noreferrer">{t('RemoteSettings.openWeb')}</a><CopyButton text={status.clientUrl} label={t('RemoteSettings.copyWeb')} /></>}
          {onWebToggle && status.webState !== undefined && <button type="button" className="button ghost" disabled={busy}
            onClick={() => onWebToggle(webState !== 'ready' && webState !== 'preparing')}>
            {t(webState === 'ready' ? 'RemoteSettings.stopWeb' : webState === 'preparing' ? 'RemoteSettings.cancelWeb' : webState === 'error' ? 'RemoteSettings.retryWeb' : 'RemoteSettings.startWeb')}
          </button>}
        </span>} />}
      {status.state === 'ready' && !status.clientUrl && <p className="remote-note" role="status">{status.webProblem || t('RemoteSettings.webUnavailable')}</p>}
    </SettingsGroup>
    <SettingsGroup title={t('RemoteSettings.devices')}>
      {devices.length === 0 ? <p className="remote-note">{t('RemoteSettings.noDevices')}</p> : devices.map((device) => (
        <SettingsRow key={device.id} label={device.name} description={<>
          <span className="remote-device-state" data-online={device.online && status.state === 'ready' || undefined}>
            {device.online && status.state === 'ready' ? t('RemoteSettings.online') : t('RemoteSettings.offline')}
          </span>
          {t('RemoteSettings.lastSeen', { time: new Date(device.lastSeenAt).toLocaleString(getLocale()) })}
        </>} control={() => <button type="button" className="button ghost" disabled={busy}
          aria-label={t('RemoteSettings.revokeNamed', { name: device.name })} onClick={() => onRevoke(device.id)}>{t('RemoteSettings.revoke')}</button>} />
      ))}
    </SettingsGroup>
  </>
}

function InvitationDialog({ invitation, browserReady, busy, onRegenerate, onClose }: {
  invitation: Invitation
  browserReady: boolean
  busy: boolean
  onRegenerate(): void
  onClose(): void
}) {
  useOccludesBrowser()
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [expired, setExpired] = useState(invitation.expiresAt <= Date.now())
  const [drawing, setDrawing] = useState<'loading' | 'ready' | 'error'>('loading')
  const [target, setTarget] = useState<'app' | 'web'>('app')
  const webAvailable = !invitation.appUrl || invitation.url !== invitation.appUrl
  const app = Boolean(invitation.appUrl) && target === 'app'
  const usable = app || webAvailable
  const link = app ? invitation.appUrl ?? invitation.url : invitation.url

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  useEffect(() => {
    setExpired(invitation.expiresAt <= Date.now())
    const timer = setTimeout(() => setExpired(true), Math.max(0, invitation.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [invitation.expiresAt])
  useEffect(() => {
    let current = true
    if (!usable) return
    setDrawing('loading')
    void import('qrcode').then(({ default: QRCode }) => {
      const element = canvas.current
      if (!current || !element) return
      const context = element.getContext('2d')
      if (!context) throw new Error('canvas unavailable')
      const code = QRCode.create(link, { errorCorrectionLevel: 'M' })
      const scale = 4
      const quietZone = 4
      element.width = element.height = (code.modules.size + quietZone * 2) * scale
      const styles = getComputedStyle(element)
      context.fillStyle = styles.backgroundColor
      context.fillRect(0, 0, element.width, element.height)
      context.fillStyle = styles.color
      for (let y = 0; y < code.modules.size; y++) for (let x = 0; x < code.modules.size; x++) {
        if (code.modules.get(y, x)) context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale)
      }
      setDrawing('ready')
    }).catch(() => { if (current) setDrawing('error') })
    return () => { current = false }
  }, [link, usable])

  return <dialog ref={dialog} className="modal remote-invitation-dialog" aria-labelledby="remote-invitation-title"
    onCancel={(event) => { event.preventDefault(); onClose() }} onClick={(event) => { if (event.target === dialog.current) onClose() }}>
    <div className="modal-body">
      <header className="modal-header"><h2 id="remote-invitation-title">{t('RemoteSettings.addPhone')}</h2>
        <button type="button" className="icon-button modal-close" aria-label={t('BackdropPicker.close')} onClick={onClose}><CloseIcon /></button>
      </header>
      {invitation.appUrl && <div className="modal-footer" role="group" aria-label={t('RemoteSettings.scanTarget')}>
        <button type="button" className={`button ${app ? 'primary' : 'ghost'}`} aria-pressed={app} onClick={() => setTarget('app')}>{t('RemoteSettings.scanInApp')}</button>
        <button type="button" className={`button ${!app ? 'primary' : 'ghost'}`} aria-pressed={!app} disabled={busy} onClick={() => { setTarget('web'); if (!webAvailable && browserReady) onRegenerate() }}>{t('RemoteSettings.scanInBrowser')}</button>
      </div>}
      <p className="remote-invitation-note">{t(app ? 'RemoteSettings.appOnlyHint' : usable ? 'RemoteSettings.browserHint' : 'RemoteSettings.browserUnavailable')}</p>
      <div className="remote-qr" aria-busy={drawing === 'loading'} hidden={expired || !usable}>
        <canvas ref={canvas} role="img" aria-label={t('RemoteSettings.qrLabel')} hidden={drawing !== 'ready'} />
        {drawing !== 'ready' && <p role="status">{t(drawing === 'error' ? 'RemoteSettings.qrFailed' : 'RemoteSettings.qrLoading')}</p>}
      </div>
      {usable && <p className="remote-invitation-note" role="status">{expired ? t('RemoteSettings.expired') : t('RemoteSettings.expiresAt', { time: new Date(invitation.expiresAt).toLocaleTimeString(getLocale()) })}</p>}
      <footer className="modal-footer">
        <button type="button" className="button ghost" onClick={onClose}>{t('BackdropPicker.close')}</button>
        {usable && (expired ? <button type="button" className="button primary" disabled={busy} onClick={onRegenerate}>{t('RemoteSettings.regenerate')}</button>
          : <CopyButton text={link} label={t('RemoteSettings.copyLink')}>{t('RemoteSettings.copyLink')}</CopyButton>)}
      </footer>
    </div>
  </dialog>
}

export function RemoteSettings() {
  const rpc = useCore((state) => state.rpc)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const epoch = useRef(0)
  const revision = useRef(0)
  const invitationRequest = useRef(0)
  const actionPending = useRef(false)
  const latest = useRef<RemoteAccessStatus | null>(null)
  const status = snapshot?.connection === rpc ? snapshot.status : null

  function closeInvitation() {
    invitationRequest.current++
    setInvitation(null)
  }

  useEffect(() => {
    const currentEpoch = ++epoch.current
    let reading = false
    latest.current = null
    actionPending.current = false
    setSnapshot(null)
    setBusy(false)
    setFailed(false)
    closeInvitation()
    if (!rpc?.features.includes('remote-access-experiment')) return
    const current = () => epoch.current === currentEpoch && useCore.getState().rpc === rpc
    const apply = (value: RemoteAccessStatus) => {
      latest.current = value
      setSnapshot({ connection: rpc, status: value })
      setFailed(false)
      if (value.state !== 'ready') closeInvitation()
    }
    const unsubscribe = rpc.on('remote.changed', ({ status: value }) => {
      if (!current()) return
      revision.current++
      apply(value)
    })
    const load = async () => {
      if (reading || actionPending.current || !current()) return
      reading = true
      const before = revision.current
      try {
        const value = await rpc.call('remote.status', {})
        if (current() && before === revision.current) apply(value)
      } catch { if (current() && before === revision.current) setFailed(true) }
      finally { reading = false }
    }
    void load()
    const interval = setInterval(() => void load(), 5000)
    return () => { epoch.current++; unsubscribe(); clearInterval(interval) }
  }, [rpc, reload])

  async function change(action: (connection: RpcConnection) => Promise<RemoteAccessStatus>, stopping = false) {
    if (!rpc || actionPending.current) return
    const currentEpoch = epoch.current
    const before = ++revision.current
    actionPending.current = true
    setBusy(true)
    if (stopping) closeInvitation()
    try {
      const value = await perform((connection) => connection === rpc ? action(connection) : Promise.resolve(null))
      if (value && epoch.current === currentEpoch && useCore.getState().rpc === rpc && before === revision.current) {
        latest.current = value
        setSnapshot({ connection: rpc, status: value })
        setFailed(false)
        if (value.state !== 'ready') closeInvitation()
      }
    } finally {
      if (epoch.current === currentEpoch) { actionPending.current = false; setBusy(false) }
    }
  }
  async function invite() {
    if (!rpc || latest.current?.state !== 'ready' || actionPending.current) return
    const currentEpoch = epoch.current
    const request = ++invitationRequest.current
    actionPending.current = true
    setBusy(true)
    try {
      const value = await perform((connection) => connection === rpc ? connection.call('remote.createInvitation', {}) : Promise.resolve(null))
      if (value && epoch.current === currentEpoch && useCore.getState().rpc === rpc && request === invitationRequest.current && latest.current?.state === 'ready') setInvitation(value)
    } finally {
      if (epoch.current === currentEpoch) { actionPending.current = false; setBusy(false) }
    }
  }

  if (!rpc?.features.includes('remote-access-experiment')) return <></>
  if (!status) return <div className="settings-loading" role="status">
    {t(failed ? 'RemoteSettings.loadFailed' : 'RemoteSettings.loading')}
    {failed && <button type="button" className="button" onClick={() => setReload((value) => value + 1)}>{t('ChatContextMenu.retry')}</button>}
  </div>
  return <>
    {failed && <p className="remote-note" role="status">{t('RemoteSettings.refreshFailed')}</p>}
    <RemoteSettingsPanel status={status} busy={busy}
      onToggle={(enabled) => void change((connection) => connection.call(enabled ? 'remote.start' : 'remote.stop', {}), !enabled)}
      onWebToggle={(enabled) => void change((connection) => connection.call(enabled ? 'remote.startWeb' : 'remote.stopWeb', {}))}
      onInvite={() => void invite()} onRevoke={(deviceId) => void change((connection) => connection.call('remote.revokeDevice', { deviceId }))} />
    {invitation && status.state === 'ready' && <InvitationDialog invitation={invitation} browserReady={Boolean(status.clientUrl)} busy={busy} onRegenerate={() => void invite()} onClose={closeInvitation} />}
  </>
}
