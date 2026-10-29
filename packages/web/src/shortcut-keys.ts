// macOS uses ⌘ where Windows and Linux use Ctrl.
export const IS_MAC = typeof navigator !== 'undefined' && (/Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent))

export const PRIMARY_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl+'
export const TASK_SHORTCUT_LABEL = IS_MAC ? '⌘N' : 'Alt+N'

export function hasPrimaryModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey
}
