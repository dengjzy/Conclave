import { registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import type { MobilePlatform } from './mobile-platform'
import { dialTailcat, loadTailcatRuntime } from './mobile-tailcat'

interface AgentsGoPlugin {
  initialize(): Promise<{ preferences: Record<string, string>; deviceName: string; active: boolean }>
  readCredential(options: { key: string }): Promise<{ value: string | null }>
  writeCredential(options: { key: string; value: string | null }): Promise<void>
  writePreference(options: { key: string; value: string | null }): Promise<void>
  scanInvitation(): Promise<{ value: string | null }>
  addListener(event: 'activity', listener: (event: { active: boolean }) => void): Promise<PluginListenerHandle>
}

export async function createNativeMobilePlatform(plugin = registerPlugin<AgentsGoPlugin>('AgentsGo')): Promise<MobilePlatform> {
  let active = true
  const listeners = new Set<(active: boolean) => void>()
  // Subscribe before the snapshot so an activity transition during startup is observed.
  let activityVersion = 0
  const activityListener = await plugin.addListener('activity', (event) => {
    activityVersion += 1
    active = event.active
    for (const listener of listeners) listener(active)
  })
  const state = await plugin.initialize().catch(async (error: unknown) => {
    await activityListener.remove()
    throw error
  })
  if (activityVersion === 0) active = state.active
  const preferences = new Map(Object.entries(state.preferences))
  let pendingPreference = Promise.resolve()
  let preferencesDurable = true
  return {
    deviceName: state.deviceName,
    credentials: {
      async read(key) { return (await plugin.readCredential({ key })).value },
      async write(key, value) { await plugin.writeCredential({ key, value }); return true }
    },
    preferences: {
      read: (key) => preferences.get(key) ?? null,
      write(key, value) {
        if (value === null) preferences.delete(key)
        else preferences.set(key, value)
        // The synchronous interface reflects this session; ordered native writes persist it.
        pendingPreference = pendingPreference.then(() => plugin.writePreference({ key, value })).catch(() => {
          preferencesDurable = false
          console.warn('agents-go: preference storage unavailable; changes remain in memory')
        })
        return preferencesDurable
      }
    },
    takeInvitation: () => null,
    scanInvitation: async () => (await plugin.scanInvitation()).value,
    prepareNetwork: () => loadTailcatRuntime('/assets/main.wasm'),
    dial: dialTailcat,
    isActive: () => active,
    subscribeActivity(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}
