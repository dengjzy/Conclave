import { usePreferences } from './preferences'
import { cssFontFamily } from './system-fonts'

// Bundled, so code and the terminal read the same on every platform; Chromium cannot name the
// system's SF Mono, and ui-monospace means nothing to it.
export const BUNDLED_CODE_FONT = 'Geist Mono Variable'
// Chinese has no place on a monospace grid, but named here it at least comes out in the platform's
// own Chinese font rather than whatever the system falls back on (SimSun on Chinese Windows).
const FALLBACK = 'Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace'

// The font stack code is set in: the family the user picked, if any, before the bundled one, and
// a Chinese family after both, which neither has the glyphs for.
export function codeFontStack(family: string, cjk = ''): string {
  return [family.trim() && cssFontFamily(family), cssFontFamily(BUNDLED_CODE_FONT), cjk.trim() && cssFontFamily(cjk), FALLBACK].filter(Boolean).join(', ')
}

// --mono follows the picked font: code blocks, diffs, file views and the terminal read the same.
export function startCodeFont(): void {
  const apply = ({ codeFontFamily, codeCjkFontFamily }: { codeFontFamily: string; codeCjkFontFamily: string }) => {
    if (codeFontFamily.trim() || codeCjkFontFamily.trim()) document.documentElement.style.setProperty('--mono', codeFontStack(codeFontFamily, codeCjkFontFamily))
    else document.documentElement.style.removeProperty('--mono')
  }
  apply(usePreferences.getState())
  usePreferences.subscribe((next, previous) => {
    if (next.codeFontFamily !== previous.codeFontFamily || next.codeCjkFontFamily !== previous.codeCjkFontFamily) apply(next)
  })
}
