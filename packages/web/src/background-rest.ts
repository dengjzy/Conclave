import { create } from 'zustand'
import { onBrowserFocused } from './desktop-bridge'

// A turn can run for an hour, and everything that says so loops for as long as it does. While the
// window is not the one being used, [data-resting] holds those loops still: their frames went to a
// window nobody was watching, and each one kept the compositor awake to draw it. A hidden window
// stops drawing on its own; an unfocused one on another screen does not, which is the case this is
// for. Only the loops rest — what enters or leaves still animates, so nothing is left half-drawn
// for the moment the window comes back. What CSS cannot pause (the pet's trips, which are Web
// Animations) reads the same state from useBackgroundRest.
export const useBackgroundRest = create<{ resting: boolean }>()(() => ({ resting: false }))

// The built-in browser's page is a view of its own, so the keyboard there leaves this document
// without leaving the window: the user is still looking at the chat beside it.
let pageFocused: string | null = null

function apply(): void {
  const resting = document.hidden || (!document.hasFocus() && pageFocused === null)
  if (resting) document.documentElement.dataset.resting = ''
  else delete document.documentElement.dataset.resting
  if (useBackgroundRest.getState().resting !== resting) useBackgroundRest.setState({ resting })
}

export function startBackgroundRest(): void {
  apply()
  window.addEventListener('focus', () => {
    // The keyboard is back here, so no page has it, even one closed while it did.
    pageFocused = null
    apply()
  })
  window.addEventListener('blur', apply)
  document.addEventListener('visibilitychange', apply)
  onBrowserFocused((tabId, focused) => {
    if (focused) pageFocused = tabId
    else if (pageFocused === tabId) pageFocused = null
    apply()
  })
}
