import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useCore } from '../core-store'
import { useOccludesBrowser } from '../browser-occlusion'
import { desktopNodeUrl, pairDesktopNode, pauseDesktopNode, removeDesktopNode, resumeDesktopNode, switchDesktopNode, useDesktopNodeSession } from '../remote/desktop-node-session'
import { ChevronDownIcon, CloseIcon, CloudIcon, PlusIcon, TrashIcon } from './icons'
import './desktop-node-switcher.css'

function currentName() {
  const { target, registry } = useDesktopNodeSession.getState()
  return target === 'local' ? '本机' : target === 'connect' ? '选择节点' : registry?.hosts.find((host) => host.id === target)?.name || '节点不可用'
}

export function DesktopNodeSwitcher() {
  const session = useDesktopNodeSession()
  const connection = useCore((state) => state.connection)
  if (!session.configured) return <span className="window-brand-name">Conclave</span>
  const name = currentName()
  const status = session.paused ? '已断开' : connection === 'connected' ? '已连接' : session.connecting ? '连接中' : '未连接'
  return <button className="desktop-node-switcher" type="button" aria-label={`切换节点：${name}，${status}`} onClick={() => useDesktopNodeSession.setState({ dialogOpen: true })} title={`${name} · ${status}`}><strong>Conclave</strong><span className="desktop-node-dot" data-online={connection === 'connected' && !session.paused} /><span className="desktop-node-name">{name}</span><ChevronDownIcon /></button>
}

export function DesktopNodeNotice() {
  const session = useDesktopNodeSession()
  const connection = useCore((state) => state.connection)
  if (!session.configured || session.target === 'local') return null
  return <div className="desktop-node-notice" role="status"><span><strong>{currentName()}</strong><span>{session.error || (session.paused ? '已断开连接' : connection !== 'connected' ? session.message || '正在连接节点…' : '会话与任务可操作；文件、终端、Git 和主机管理请在节点主机操作。')}</span></span><button type="button" className="button ghost" onClick={() => useDesktopNodeSession.setState({ dialogOpen: true })}>{session.target === 'connect' ? '连接节点' : '管理连接'}</button></div>
}

export function DesktopNodeDialog() {
  const open = useDesktopNodeSession((state) => state.dialogOpen)
  useOccludesBrowser(open)
  return open ? <NodeDialogBody /> : null
}

function NodeDialogBody() {
  const session = useDesktopNodeSession()
  const registry = session.registry
  const connection = useCore((state) => state.connection)
  const [adding, setAdding] = useState(session.target === 'connect' || Boolean(registry?.isPairing) || !registry?.hosts.length)
  const [link, setLink] = useState('')
  const [deviceName, setDeviceName] = useState(registry?.platform.deviceName || '电脑浏览器')
  const [hostName, setHostName] = useState(registry?.invitationName || '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(true)
  const acting = useRef(false)
  const close = () => useDesktopNodeSession.setState({ dialogOpen: false })
  useEffect(() => {
    mounted.current = true
    dialog.current?.showModal()
    return () => { mounted.current = false; dialog.current?.close() }
  }, [])
  async function act(action: () => Promise<void>) {
    if (acting.current) return
    acting.current = true; setBusy(true); setProblem('')
    try { await action() }
    catch (error) { if (mounted.current) setProblem(error instanceof Error ? error.message : '操作失败') }
    finally { acting.current = false; if (mounted.current) setBusy(false) }
  }
  function select(id: string | null) {
    if (id === session.target || (id === null && session.target === 'local')) {
      if (session.paused) resumeDesktopNode()
      close()
    } else {
      try { switchDesktopNode(id) } catch (error) { setProblem(error instanceof Error ? error.message : '切换失败') }
    }
  }
  function pair(event: FormEvent) { event.preventDefault(); void act(() => pairDesktopNode(link, deviceName, hostName || undefined)) }
  return <dialog ref={dialog} className="modal desktop-node-dialog" aria-labelledby="desktop-node-title" onCancel={(event) => { event.preventDefault(); if (!busy) close() }} onClick={(event) => { if (!busy && event.target === event.currentTarget) close() }}>
    <div className="modal-body"><header className="modal-header"><h2 id="desktop-node-title">连接节点</h2><button className="icon-button" aria-label="关闭节点连接" disabled={busy} onClick={close}><CloseIcon /></button></header>
      <p className="desktop-node-explanation">切换后会重新加载工作区。会话、任务与项目来自所选电脑。</p>
      <div className="desktop-node-list" aria-label="已保存的节点">
        {session.localAvailable && <div className="desktop-node-row"><button type="button" disabled={busy} aria-current={session.target === 'local' ? 'true' : undefined} onClick={() => select(null)}><CloudIcon /><span><strong>本机</strong><small>{session.target === 'local' ? connection === 'connected' ? '已连接' : '未连接' : '此入口的本机 Conclave'}</small></span>{session.target === 'local' && <span aria-hidden="true">✓</span>}</button></div>}
        {registry?.hosts.map((host) => <div className="desktop-node-row" key={host.id}><button type="button" disabled={busy} aria-current={session.target === host.id ? 'true' : undefined} onClick={() => select(host.id)}><CloudIcon /><span><strong>{host.name}</strong><small>{session.target === host.id ? session.paused ? '已断开' : connection === 'connected' ? '已连接' : '未连接' : '已配对'}</small></span>{session.target === host.id && <span aria-hidden="true">✓</span>}</button><button type="button" className="icon-button" aria-label={`移除节点 ${host.name}`} title="从当前浏览器移除此连接" disabled={busy || session.connecting} onClick={() => void act(() => removeDesktopNode(host.id))}><TrashIcon /></button></div>)}
      </div>
      {session.target !== 'local' && session.target !== 'connect' && <div className="desktop-node-actions"><button className="button" disabled={busy || session.connecting} onClick={() => { if (session.paused) resumeDesktopNode(); else pauseDesktopNode() }}>{session.paused ? '重新连接' : '断开连接'}</button><a className="button ghost" href={mobileUrl()}>使用手机版界面</a></div>}
      {!adding ? <button className="button desktop-node-add" disabled={busy} onClick={() => setAdding(true)}><PlusIcon />添加节点</button> : <form className="desktop-node-form" onSubmit={pair}>
        <h3>{registry?.isPairing ? '确认配对' : '添加节点'}</h3>
        {registry?.isPairing && <p className="desktop-node-explanation">{registry.invitationName || '配对链接已导入'} · 请确认来自你的电脑。</p>}
        {!registry?.isPairing && <label className="modal-field"><span className="modal-label">配对链接</span><textarea className="modal-input modal-textarea" aria-label="配对链接" value={link} onChange={(event) => setLink(event.target.value)} rows={3} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="粘贴电脑设置 → 远程连接生成的完整链接" /></label>}
        <label className="modal-field"><span className="modal-label">设备名称</span><input className="modal-input" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} required /></label>
        <label className="modal-field"><span className="modal-label">节点名称（可选）</span><input className="modal-input" value={hostName} onChange={(event) => setHostName(event.target.value)} maxLength={80} placeholder="使用电脑提供的名称" /></label>
        <button type="submit" className="button primary" disabled={busy || session.connecting || (!link.trim() && !registry?.isPairing) || !deviceName.trim()}>{busy ? '正在配对…' : '配对并打开工作区'}</button>
      </form>}
      {(problem || session.error || registry?.invitationProblem) && <p className="modal-error" role="alert">{problem || session.error || registry?.invitationProblem}</p>}
      {registry?.storageNotice && <p className="modal-error" role="alert">{registry.storageNotice}</p>}
    </div>
  </dialog>
}

function mobileUrl(): string {
  const url = new URL(desktopNodeUrl(null))
  url.pathname = '/mobile.html'
  return url.href
}
