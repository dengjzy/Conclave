import { usePreferences } from './preferences'
import { cssFontFamily } from './system-fonts'

// The chat's type from the settings, as the attributes a .chat-view reads: every view of a chat (a
// conversation, a new one's draft, the helper's) sets its messages alike.
export function useChatTypeface() {
  const size = usePreferences((s) => s.chatFontSize)
  const font = usePreferences((s) => s.chatFont)
  const family = usePreferences((s) => s.chatFontFamily)
  const cjk = usePreferences((s) => s.chatCjkFontFamily)
  // Families picked from those installed go in as properties: the stylesheet puts the font first,
  // and the Chinese one after the Latin, in place of the one that goes with it.
  const custom = font === 'custom' && family ? cssFontFamily(family) : null
  const style = { ...(custom ? { '--chat-font-custom': custom } : {}), ...(cjk.trim() ? { '--chat-font-cjk': cssFontFamily(cjk) } : {}) }
  return {
    'data-font-size': size,
    'data-font': font === 'custom' && !custom ? 'system' : font,
    style: Object.keys(style).length > 0 ? style : undefined
  }
}
