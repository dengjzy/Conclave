import { dialTailcat, loadTailcatRuntime } from '../mobile/mobile-tailcat'

export interface NodeTunnel {
  read(): Promise<Uint8Array | null>
  write(bytes: Uint8Array): Promise<void>
  close(): void
}

export interface NodeCredentials {
  read(key: string): Promise<string | null>
  /** False means this page retains the value, but a new launch may lose it. */
  write(key: string, value: string | null): Promise<boolean>
}

export interface NodePreferences {
  read(key: string): string | null
  write(key: string, value: string | null): boolean
}

/**
 * App shells provide their keychain, lifecycle and transport through this boundary.
 * Scan/deep-link handlers pass the untouched link to importInvitation; they never
 * navigate to it. The UI may connect after an explicit scan. Subscriptions must return a disposer.
 */
export interface NodePlatform {
  deviceName?: string
  scanInvitation?(): Promise<string | null>
  credentials: NodeCredentials
  preferences: NodePreferences
  takeInvitation(): string | null
  prepareNetwork(): Promise<void>
  dial(options: { addr: string; port: number }): Promise<NodeTunnel>
  isActive(): boolean
  subscribeActivity(listener: (active: boolean) => void): () => void
}

function browserStorage(): NodePreferences {
  const memory = new Map<string, string | null>()
  return {
    read(key) {
      if (memory.has(key)) return memory.get(key) ?? null
      try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null }
    },
    write(key, value) {
      memory.set(key, value)
      try {
        const storage = globalThis.localStorage
        if (!storage) return false
        if (value === null) storage.removeItem(key)
        else storage.setItem(key, value)
        return true
      } catch { return false }
    }
  }
}

export function createBrowserNodePlatform(): NodePlatform {
  const credentials = browserStorage()
  const preferences = browserStorage()
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return {
    deviceName: /Android/i.test(agent) ? 'Android 浏览器' : /iPhone|iPad/i.test(agent) ? 'iOS 浏览器' : '电脑浏览器',
    credentials: {
      async read(key) { return credentials.read(key) },
      async write(key, value) { return credentials.write(key, value) }
    },
    preferences,
    takeInvitation() {
      if (typeof location === 'undefined' || !location.hash) return null
      const fragment = location.hash
      if (!new URLSearchParams(fragment.slice(1)).has('pair')) return null
      // A consumed ticket must not remain in browser history or copied URLs.
      history.replaceState(null, '', location.pathname + (location.search ?? ''))
      return fragment
    },
    prepareNetwork: loadTailcatRuntime,
    dial: dialTailcat,
    isActive: () => typeof document === 'undefined' || !document.hidden,
    subscribeActivity(listener) {
      if (typeof document === 'undefined') return () => {}
      const changed = () => listener(!document.hidden)
      document.addEventListener('visibilitychange', changed)
      return () => document.removeEventListener('visibilitychange', changed)
    }
  }
}
