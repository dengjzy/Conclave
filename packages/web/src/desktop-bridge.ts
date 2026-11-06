import { t } from './i18n'
import { isRemoteDesktopNode } from './remote/desktop-node-mode'
import { z } from 'zod'
import { AgentKind, BookmarkFields } from '@conclave/protocol'
import type { ActionableTarget, Notice } from './attention'

// What an Electron preload or native container exposes; absent when the UI runs in a plain browser.
declare global {
  interface Window {
    conclave?: {
      platform: string
      onFullScreenChange(listener: (fullScreen: boolean) => void): () => void
      getCoreEndpoint(): Promise<unknown>
      appVersion?(): Promise<unknown>
      pickPlugin?(kind: 'directory' | 'zip'): Promise<unknown>
      pickFolder(defaultPath?: string, title?: string): Promise<unknown>
      setTheme(theme: string): Promise<unknown>
      setLanguage?(locale: string): Promise<unknown>
      revealFile?(candidates: string[]): Promise<unknown>
      openFile?(path: string): Promise<unknown>
      openWithApps?(): Promise<unknown>
      openWith?(path: string, app: string): Promise<unknown>
      notify?(notice: unknown): Promise<unknown>
      setBadge?(count: number): Promise<unknown>
      onNotificationClick?(listener: (target: unknown) => void): () => void
      requestPopup?(wanted: boolean): Promise<unknown>
      onRequestPopupWanted?(listener: (wanted: boolean) => void): () => void
      requestPopupLayout?(layout: { visible: boolean; height: number }): void
      openFromRequestPopup?(target: unknown): Promise<unknown>
      browserShow?(tabId: string | null): Promise<unknown>
      browserBounds?(bounds: { x: number; y: number; width: number; height: number }): void
      browserOccluded?(occluded: boolean): Promise<unknown>
      bookmarkSources?(): Promise<unknown>
      readBookmarks?(id: string): Promise<unknown>
      pickBookmarksFile?(): Promise<unknown>
      onBrowserFocused?(listener: (event: unknown) => void): () => void
      onBrowserShortcut?(listener: (event: unknown) => void): () => void
      updateState?(): Promise<unknown>
      checkForUpdate?(): Promise<unknown>
      installUpdate?(): Promise<unknown>
      skipUpdate?(version: string | null): Promise<unknown>
      setUpdateAutomatic?(automatic: boolean): Promise<unknown>
      setUpdatePrerelease?(prerelease: boolean): Promise<unknown>
      onUpdate?(listener: (state: unknown) => void): () => void
    }
  }
}

// In plain browser, determine platform from userAgent
export function detectedPlatform(): string {
  if (window.conclave?.platform) return window.conclave.platform
  const ua = navigator.userAgent
  if (ua.includes('Mac')) return 'darwin'
  if (ua.includes('Win')) return 'win32'
  return 'linux'
}

export function applyTitleBar(): void {
  if (window.conclave?.platform !== 'darwin') {
    return
  }
  const root = document.documentElement
  root.dataset.titlebar = 'inset'
  window.conclave.onFullScreenChange((fullScreen) => {
    if (fullScreen) {
      root.dataset.fullscreen = ''
    } else {
      delete root.dataset.fullscreen
    }
  })
}

export async function appVersion(): Promise<string | null> {
  const version = await window.conclave?.appVersion?.().catch(() => null)
  return typeof version === 'string' && version ? version : '0.0.1'
}

export function canPickFolder(): boolean {
  return !isRemoteDesktopNode()
}

export async function pickFolder(defaultPath?: string, title?: string): Promise<string | null> {
  if (isRemoteDesktopNode()) return null
  if (window.conclave?.pickFolder) {
    const picked = await window.conclave.pickFolder(defaultPath, title)
    return typeof picked === 'string' && picked !== '' ? picked : null
  }
  // Try native system folder picker via Core RPC (zenity on Linux, osascript on macOS)
  try {
    const { perform } = await import('./core-store')
    const res = await perform((rpc) => rpc.call('system.pickFolder', { defaultPath, title }))
    if (res && res.path) return res.path
  } catch {}

  const defaultVal = defaultPath || '/home/swrd/workspace'
  const promptMsg = title ? `${title}\n请输入绝对路径:` : '请输入项目或文件夹的绝对路径 (如 /home/swrd/...):'
  const entered = window.prompt(promptMsg, defaultVal)
  return entered && entered.trim() ? entered.trim() : null
}

export function canRevealFile(): boolean {
  return !isRemoteDesktopNode() && window.conclave?.revealFile !== undefined
}

export function canOpenFile(): boolean {
  return !isRemoteDesktopNode()
}

export async function openFile(path: string): Promise<string | null> {
  if (isRemoteDesktopNode()) return '请在节点电脑上打开此文件'
  if (window.conclave?.openFile) {
    const error = await window.conclave.openFile(path)
    return typeof error === 'string' ? error || null : t('desktopBridge.thisClientCannotOpenFilesWithTheSystem')
  }
  // Browser fallback: trigger vscode protocol
  const uri = `vscode://file${path.startsWith('/') ? '' : '/'}${encodeURI(path)}`
  window.open(uri, '_blank')
  return null
}

const OpenWithApp = z.object({ id: z.string(), name: z.string(), kind: z.enum(['editor', 'terminal']), icon: z.string().nullable() })
export type OpenWithApp = z.infer<typeof OpenWithApp>

export function canOpenWith(): boolean {
  return !isRemoteDesktopNode()
}

let openWithApps: Promise<OpenWithApp[]> | null = null
export function installedOpenWithApps(): Promise<OpenWithApp[]> {
  if (isRemoteDesktopNode()) return Promise.resolve([])
  if (window.conclave?.openWithApps) {
    openWithApps ??= (window.conclave.openWithApps().catch(() => [])).then((found) => z.array(OpenWithApp).catch([]).parse(found), () => [])
    return openWithApps
  }
  return Promise.resolve([
    { id: 'vscode', name: 'VS Code', kind: 'editor', icon: null }
  ])
}

export async function openWith(path: string, app: string): Promise<string | null> {
  if (isRemoteDesktopNode()) return '请在节点电脑上使用编辑器或终端'
  if (window.conclave?.openWith) {
    const error = await window.conclave.openWith(path, app)
    return typeof error === 'string' ? error || null : t('desktopBridge.thisClientCannotOpenFilesWithOtherApps')
  }
  if (app === 'vscode') {
    const uri = `vscode://file${path.startsWith('/') ? '' : '/'}${encodeURI(path)}`
    window.open(uri, '_blank')
    return null
  }
  return null
}

export async function revealFile(candidates: readonly string[]): Promise<string | null> {
  if (isRemoteDesktopNode()) return null
  if (window.conclave?.revealFile) {
    const shown = await window.conclave.revealFile([...candidates])
    return typeof shown === 'string' ? shown : null
  }
  return candidates[0] ?? null
}

export function canNotify(): boolean {
  return typeof Notification !== 'undefined' || window.conclave?.notify !== undefined
}

const notificationListeners = new Set<(target: Notice['target']) => void>()

export function notify(notice: Notice): void {
  if (!isRemoteDesktopNode() && window.conclave?.notify) {
    void window.conclave.notify(notice).catch(() => {})
    return
  }
  if (typeof Notification !== 'undefined') {
    if (Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    if (Notification.permission === 'granted') {
      try {
        const n = new Notification(notice.title, { body: notice.body })
        n.onclick = () => {
          window.focus()
          if (notice.target) {
            notificationListeners.forEach((l) => l(notice.target))
          }
        }
      } catch {}
    }
  }
}

export function setBadge(count: number): void {
  if (window.conclave?.setBadge) {
    void window.conclave.setBadge(count).catch(() => {})
    return
  }
  const baseTitle = 'Conclave'
  document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle
}

const Target = z.union([
  z.object({ kind: z.enum(['task', 'conversation']), id: z.string() }),
  z.object({ kind: z.literal('routines') }),
  z.object({ kind: z.literal('usage'), agent: AgentKind })
])

export function onNotificationClick(listener: (target: Notice['target']) => void): () => void {
  if (!isRemoteDesktopNode() && window.conclave?.onNotificationClick) {
    return window.conclave.onNotificationClick((target) => {
      const parsed = Target.safeParse(target)
      if (parsed.success) listener(parsed.data)
    })
  }
  notificationListeners.add(listener)
  return () => notificationListeners.delete(listener)
}

export function canShowRequestPopup(): boolean {
  return !isRemoteDesktopNode() && window.conclave?.requestPopup !== undefined
}

export function wantRequestPopup(wanted: boolean): void {
  if (isRemoteDesktopNode()) return
  void window.conclave?.requestPopup?.(wanted).catch(() => {})
}

export function onRequestPopupWanted(listener: (wanted: boolean) => void): () => void {
  if (isRemoteDesktopNode()) return () => {}
  return window.conclave?.onRequestPopupWanted?.(listener) ?? (() => {})
}

export function layoutRequestPopup(visible: boolean, height: number): void {
  if (isRemoteDesktopNode()) return
  window.conclave?.requestPopupLayout?.({ visible, height })
}

export function openFromRequestPopup(target: ActionableTarget): void {
  if (isRemoteDesktopNode()) return
  void window.conclave?.openFromRequestPopup?.(target).catch(() => {})
}

export function canShowNativeBrowser(): boolean {
  return !isRemoteDesktopNode() && window.conclave?.browserShow !== undefined
}

export function showNativeBrowserTab(tabId: string | null): void {
  if (isRemoteDesktopNode()) return
  void window.conclave?.browserShow?.(tabId).catch(() => {})
}

export function reportBrowserBounds(rect: { x: number; y: number; width: number; height: number }): void {
  if (isRemoteDesktopNode()) return
  window.conclave?.browserBounds?.({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

export function setBrowserOccluded(occluded: boolean): void {
  if (isRemoteDesktopNode()) return
  void window.conclave?.browserOccluded?.(occluded).catch(() => {})
}

export function canImportBookmarks(): boolean {
  return !isRemoteDesktopNode() && window.conclave?.bookmarkSources !== undefined
}

const BookmarkSource = z.object({ id: z.string(), browser: z.string(), profile: z.string(), count: z.number() })
export type BookmarkSource = z.infer<typeof BookmarkSource>

export async function bookmarkSources(): Promise<BookmarkSource[]> {
  if (isRemoteDesktopNode()) return []
  const found = await window.conclave?.bookmarkSources?.().catch(() => [])
  return z.array(BookmarkSource).catch([]).parse(found ?? [])
}

export async function readBookmarks(id: string): Promise<BookmarkFields[]> {
  if (isRemoteDesktopNode()) return []
  return z.array(BookmarkFields).parse(await window.conclave?.readBookmarks?.(id))
}

export async function pickBookmarksFile(): Promise<BookmarkFields[] | null> {
  if (isRemoteDesktopNode()) return null
  const picked = await window.conclave?.pickBookmarksFile?.()
  return picked === null || picked === undefined ? null : z.array(BookmarkFields).parse(picked)
}

const Focused = z.object({ tabId: z.string(), focused: z.boolean() })

export function onBrowserFocused(listener: (tabId: string, focused: boolean) => void): () => void {
  if (isRemoteDesktopNode()) return () => {}
  return (
    window.conclave?.onBrowserFocused?.((event) => {
      const parsed = Focused.safeParse(event)
      if (parsed.success) listener(parsed.data.tabId, parsed.data.focused)
    }) ?? (() => {})
  )
}

const Shortcut = z.object({ kind: z.enum(['toggle-browser', 'settings']) })

export function onBrowserShortcut(listener: (kind: 'toggle-browser' | 'settings') => void): () => void {
  if (isRemoteDesktopNode()) return () => {}
  return (
    window.conclave?.onBrowserShortcut?.((event) => {
      const parsed = Shortcut.safeParse(event)
      if (parsed.success) listener(parsed.data.kind)
    }) ?? (() => {})
  )
}

export function setNativeTheme(theme: 'system' | 'light' | 'dark'): void {
  if (window.conclave?.setTheme) {
    void window.conclave.setTheme(theme).catch(() => {})
  }
  document.documentElement.dataset.theme = theme
}

export async function pickPlugin(kind: 'directory' | 'zip'): Promise<string | null> {
  if (isRemoteDesktopNode()) return null
  const picked = await window.conclave?.pickPlugin?.(kind)
  return typeof picked === 'string' && picked ? picked : null
}
