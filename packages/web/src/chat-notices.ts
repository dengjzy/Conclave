import { getLocale, t } from './i18n'
import { CONTEXT_COMPACTED, cursorProviderError } from '@conclave/protocol'

export function isCompaction(text: string): boolean {
  return text === CONTEXT_COMPACTED
}

// Claude Code once said when a usage limit lifts only as epoch seconds after a bar; say the local
// time instead.
export function readableNotice(text: string): string {
  const provider = cursorProviderError(text.trim(), getLocale())
  if (provider && !provider.rest) return provider.summary
  return text.replace(/Claude AI usage limit reached\|(\d{10})/g, (_match, seconds: string) => {
    const at = new Date(Number(seconds) * 1000)
    const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`
    const sameDay = at.toDateString() === new Date().toDateString()
    return t('chatNotices.claudeSUsageLimitWasReachedResets', { value1: sameDay ? '' : t('chatNotices.resetDate', { value1: at.getMonth() + 1, value2: at.getDate() }), time: time })
  })
}

// A notice longer than a line opens onto the rest.
export function noticeSummary(text: string): { first: string; more: boolean } {
  const [first = '', ...rest] = text.split('\n')
  const long = first.length > 160
  return { first: long ? `${first.slice(0, 160)}…` : first, more: long || rest.some((line) => line.trim() !== '') }
}
