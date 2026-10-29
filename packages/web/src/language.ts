import { startLanguage } from './i18n'
import { usePreferences } from './preferences'

// Each window follows the same saved preference and resolves system changes independently.
export function startUiLanguage(): () => void {
  const apply = () => startLanguage(usePreferences.getState().language)
  apply()
  const unsubscribe = usePreferences.subscribe((next, previous) => {
    if (next.language !== previous.language) apply()
  })
  window.addEventListener('languagechange', apply)
  return () => {
    unsubscribe()
    window.removeEventListener('languagechange', apply)
  }
}
