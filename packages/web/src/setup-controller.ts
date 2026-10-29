import { useEffect } from 'react'
import { useCore } from './core-store'
import { setPreference, usePreferences } from './preferences'
import { initialSetupStatus, type SetupProgress } from './setup-progress'

export function updateSetup(change: Partial<SetupProgress>): void {
  setPreference('setup', { ...usePreferences.getState().setup, ...change })
}

export function openSetup(): void {
  useCore.setState({ guideOpen: false })
  const previous = usePreferences.getState().setup
  updateSetup({ status: 'active', ...(previous.status === 'complete' ? { sourceChoice: 'pending', sessionChoice: 'pending', confirmed: null } : {}) })
}

export function useFirstRunSetup(): void {
  const connected = useCore((state) => state.connection === 'connected')
  const environment = useCore((state) => state.environment)
  const sources = useCore((state) => state.sources)
  useEffect(() => {
    const { setup, guideSeen } = usePreferences.getState()
    if (!connected || !environment || sources === null || setup.status !== 'new') return
    const state = useCore.getState()
    const hasWork = Object.keys(state.tasks).length > 0 || Object.keys(state.conversations).length > 0
    updateSetup({ status: initialSetupStatus(guideSeen, hasWork) })
    setPreference('guideSeen', true)
  }, [connected, environment, sources])
}
