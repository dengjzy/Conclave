import { useEffect } from 'react'
import { create } from 'zustand'
import { UpdateState } from './shared/app-update'
import { releaseIdleChats } from './core-store'

// What main last said of a newer Conclave; null outside Electron, or in a dev build that does not look.
export const useUpdate = create<{ state: UpdateState | null }>()(() => ({ state: null }))

function accept(value: unknown): void {
  const parsed = UpdateState.safeParse(value)
  if (parsed.success) useUpdate.setState({ state: parsed.data })
}

export function useUpdateFeed(): void {
  useEffect(() => {
    const bridge = window.conclave
    if (!bridge?.updateState || !bridge.onUpdate) return
    const stop = bridge.onUpdate(accept)
    void bridge.updateState().then(accept, () => {})
    return stop
  }, [])
}

export function checkForUpdate(): void {
  void window.conclave?.checkForUpdate?.().catch(() => {})
}

export function installUpdate(): void {
  void (async () => {
    if (window.conclave?.platform === 'win32') await releaseIdleChats().catch(() => {})
    await window.conclave?.installUpdate?.()
  })().catch(() => {})
}

export function skipUpdate(version: string | null): void {
  void window.conclave?.skipUpdate?.(version).catch(() => {})
}

export function setUpdatePrerelease(prerelease: boolean): void {
  void window.conclave?.setUpdatePrerelease?.(prerelease).catch(() => {})
}

export async function setUpdateAutomatic(automatic: boolean): Promise<void> {
  if (!window.conclave?.setUpdateAutomatic) throw new Error('unsupported')
  await window.conclave.setUpdateAutomatic(automatic)
}

// Whether the status bar offers the update: a newer version the user has not skipped, or one under way.
export function updateOffered(state: UpdateState | null): boolean {
  if (!state?.latest) return false
  if (state.status === 'downloading' || state.status === 'installing') return true
  return state.latest.version !== state.skipped && ['available', 'ready', 'checking', 'error'].includes(state.status)
}
