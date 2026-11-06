import { create } from 'zustand'
import { connectRpc, coreUrl, type RpcConnection } from '@conclave/protocol'
import { resolveCoreEndpoint } from '../core-endpoint'
import { NodeConnection } from './node-connection'
import { connectDesktopRpc } from './node-rpc'

export type DesktopNodeTarget = 'local' | 'connect' | string
export type DesktopNodeSession = {
  configured: boolean
  target: DesktopNodeTarget
  localAvailable: boolean
  registry: NodeConnection | null
  paused: boolean
  connecting: boolean
  message: string
  error: string | null
  revision: number
  dialogOpen: boolean
}
export const useDesktopNodeSession = create<DesktopNodeSession>(() => ({ configured: false, target: 'local', localAvailable: false, registry: null, paused: false, connecting: false, message: '', error: null, revision: 0, dialogOpen: false }))

export function desktopNodeUrl(hostId: string | null, href = window.location.href): string {
  const url = new URL(href)
  if (hostId === null) url.searchParams.delete('node')
  else url.searchParams.set('node', hostId)
  url.searchParams.delete('token'); url.searchParams.delete('port')
  url.hash = ''
  return url.href
}

export function switchDesktopNode(hostId: string | null): void {
  const session = useDesktopNodeSession.getState()
  if (hostId === null && !session.localAvailable) throw new Error('此入口没有本机节点，请选择已保存的电脑')
  if (hostId !== null && hostId !== 'connect' && !session.registry?.hosts.some((host) => host.id === hostId)) throw new Error('此节点已被移除，请重新配对')
  useDesktopNodeSession.setState({ paused: true })
  session.registry?.disconnect()
  // Rebuilding the document discards every singleton, subscription and node-specific draft cache.
  window.location.assign(desktopNodeUrl(hostId))
}

export function pauseDesktopNode(): void {
  useDesktopNodeSession.setState({ paused: true, connecting: false, error: null })
  useDesktopNodeSession.getState().registry?.disconnect('已断开，点击连接可恢复')
}

export function resumeDesktopNode(): void {
  useDesktopNodeSession.setState({ paused: false, error: null })
}

export async function pairDesktopNode(link: string, deviceName: string, hostName?: string): Promise<void> {
  const session = useDesktopNodeSession.getState()
  const registry = session.registry
  if (!registry) throw new Error('节点列表尚未准备好')
  if (session.connecting) throw new Error('正在连接，请稍候')
  // Parsing happens before disturbing the current connection.
  if (link.trim()) registry.importInvitation(link)
  else if (!registry.isPairing) throw new Error('请粘贴电脑生成的完整配对链接')
  useDesktopNodeSession.setState({ paused: true, connecting: true, error: null })
  try {
    await registry.connect(deviceName, hostName)
    const id = registry.activeHostId
    if (!id) throw new Error('配对未返回节点，请重新连接')
    if (registry.storageNotice) throw new Error(`${registry.storageNotice}。请允许保存连接后重试。`)
    switchDesktopNode(id)
  } catch (failure) {
    useDesktopNodeSession.setState({ error: failure instanceof Error ? failure.message : '配对失败' })
    throw failure
  } finally { useDesktopNodeSession.setState({ connecting: false }) }
}

export async function removeDesktopNode(id: string): Promise<void> {
  const { registry, target } = useDesktopNodeSession.getState()
  if (!registry) return
  useDesktopNodeSession.setState({ paused: true })
  registry.selectHost(id)
  registry.forget()
  const saved = await registry.flushCredentials()
  if (!saved) throw new Error('节点已从当前页面移除，但设备存储未能保存，请重试')
  // Even removing an inactive entry reloads: the credential manager also owns the live tunnel.
  switchDesktopNode(target === 'local' ? null : target === id || target === 'connect' ? 'connect' : target)
}

export async function prepareDesktopNodeSession({ localAvailable }: { localAvailable: boolean }): Promise<() => Promise<RpcConnection | null>> {
  const query = new URLSearchParams(window.location.search)
  const requested = query.get('node')
  const target = requested || (localAvailable ? 'local' : 'connect')
  const registry = new NodeConnection((message) => useDesktopNodeSession.setState((state) => ({ message, revision: state.revision + 1 })))
  await registry.ready
  let error: string | null = null
  if (target === 'local' && !localAvailable) error = '此入口没有本机节点，请选择已保存的电脑'
  else if (target !== 'local' && target !== 'connect') {
    if (registry.hosts.some((host) => host.id === target)) registry.selectHost(target)
    else error = '此节点未保存在当前浏览器中，请重新配对'
  }
  useDesktopNodeSession.setState({ configured: true, target, localAvailable, registry, paused: Boolean(error), connecting: false, dialogOpen: target === 'connect' || Boolean(error), error, message: target === 'connect' ? '选择节点或粘贴电脑生成的配对链接' : '' })
  return async () => {
    const current = useDesktopNodeSession.getState()
    if (current.paused || target === 'connect') return null
    if (target === 'local') {
      if (!localAvailable) return null
      const endpoint = await resolveCoreEndpoint()
      return endpoint ? connectRpc(coreUrl(endpoint)) : null
    }
    if (registry.activeHostId !== target || registry.isPairing) throw new Error('节点选择已改变，请重新载入页面')
    useDesktopNodeSession.setState({ connecting: true })
    try {
      await registry.connect(registry.platform.deviceName || '电脑浏览器')
      if (useDesktopNodeSession.getState().paused) { registry.disconnect(); return null }
      const rpc = await connectDesktopRpc(registry)
      if (useDesktopNodeSession.getState().paused) { rpc.close(); return null }
      useDesktopNodeSession.setState({ error: null })
      return rpc
    } catch (failure) {
      registry.disconnect()
      useDesktopNodeSession.setState({ error: failure instanceof Error ? failure.message : '远程节点连接失败' })
      throw failure
    } finally { useDesktopNodeSession.setState({ connecting: false }) }
  }
}
