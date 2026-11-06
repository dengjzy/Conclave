import { create } from 'zustand'

// Pause looping animations in unfocused windows, including those still visible on another screen.
// One-off transitions continue so returning to the window never finds them half-drawn.
export const useBackgroundRest = create<{ resting: boolean }>()(() => ({ resting: false }))

function apply(): void {
  const resting = document.hidden || !document.hasFocus()
  if (resting) document.documentElement.dataset.resting = ''
  else delete document.documentElement.dataset.resting
  if (useBackgroundRest.getState().resting !== resting) useBackgroundRest.setState({ resting })
}

export function startBackgroundRest(): void {
  apply()
  window.addEventListener('focus', apply)
  window.addEventListener('blur', apply)
  document.addEventListener('visibilitychange', apply)
}
