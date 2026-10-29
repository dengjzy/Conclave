import { setNativeTheme } from './desktop-bridge'
import { usePreferences, type Preferences } from './preferences'

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

// The CSS resolves the tokens: [data-theme] pins a theme, its absence follows the system, and
// [data-palette] picks the set of colours, and [data-backdrop] the frame's gradient, if any.
function apply(theme: Preferences['theme'], palette: Preferences['palette'], backdrop: Preferences['backdrop']): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
  document.documentElement.dataset.palette = palette
  if (backdrop === 'none') {
    delete document.documentElement.dataset.backdrop
  } else {
    document.documentElement.dataset.backdrop = backdrop
  }
  setNativeTheme(theme)
}

export function startAppearance(): void {
  const { theme, palette, backdrop } = usePreferences.getState()
  apply(theme, palette, backdrop)
  usePreferences.subscribe((next, previous) => {
    if (next.theme !== previous.theme || next.palette !== previous.palette || next.backdrop !== previous.backdrop) {
      apply(next.theme, next.palette, next.backdrop)
    }
  })
}

export function isDarkTheme(): boolean {
  return getComputedStyle(document.documentElement).colorScheme === 'dark'
}

// Fires when the colours may have changed: a system switch, or a new theme or palette.
export function onThemeChange(listener: () => void): () => void {
  systemDark.addEventListener('change', listener)
  const unsubscribe = usePreferences.subscribe((next, previous) => {
    if (next.theme !== previous.theme || next.palette !== previous.palette) {
      listener()
    }
  })
  return () => {
    systemDark.removeEventListener('change', listener)
    unsubscribe()
  }
}
