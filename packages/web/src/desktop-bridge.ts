import { t } from './i18n'
import { z } from 'zod'
import { AgentKind } from '@conclave/protocol'
import type { Notice } from './attention'

// What an Electron preload or native container exposes; absent when the UI runs in a plain browser.
declare global {
  interface Window {
    conclave?: {
      platform: string
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

export async function appVersion(): Promise<string | null> {
  const version = await window.conclave?.appVersion?.().catch(() => null)
  return typeof version === 'string' && version ? version : '0.2.0'
}

export function canPickFolder(): boolean {
  return true
}

export async function pickFolder(defaultPath?: string, title?: string): Promise<string | null> {
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
  return window.conclave?.revealFile !== undefined
}

export function canOpenFile(): boolean {
  return true
}

export async function openFile(path: string): Promise<string | null> {
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
  return true
}

let openWithApps: Promise<OpenWithApp[]> | null = null
export function installedOpenWithApps(): Promise<OpenWithApp[]> {
  if (window.conclave?.openWithApps) {
    openWithApps ??= (window.conclave.openWithApps().catch(() => [])).then((found) => z.array(OpenWithApp).catch([]).parse(found), () => [])
    return openWithApps
  }
  return Promise.resolve([
    { id: 'vscode', name: 'VS Code', kind: 'editor', icon: null }
  ])
}

export async function openWith(path: string, app: string): Promise<string | null> {
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
  if (window.conclave?.notify) {
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
  if (window.conclave?.onNotificationClick) {
    return window.conclave.onNotificationClick((target) => {
      const parsed = Target.safeParse(target)
      if (parsed.success) listener(parsed.data)
    })
  }
  notificationListeners.add(listener)
  return () => notificationListeners.delete(listener)
}

export function setNativeTheme(theme: 'system' | 'light' | 'dark'): void {
  if (window.conclave?.setTheme) {
    void window.conclave.setTheme(theme).catch(() => {})
  }
  document.documentElement.dataset.theme = theme
}

export async function pickPlugin(kind: 'directory' | 'zip'): Promise<string | null> {
  const picked = await window.conclave?.pickPlugin?.(kind)
  return typeof picked === 'string' && picked ? picked : null
}
