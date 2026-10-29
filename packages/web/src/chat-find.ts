export type TextMatch = { start: number; end: number }

// Literal, case-insensitive matching preserves UTF-16 offsets even when lowercasing expands a letter.
export function textMatches(text: string, query: string): TextMatch[] {
  if (!query.trim()) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
}

const IGNORE = 'script, style, input, textarea, select, [hidden], [aria-hidden="true"], [data-find-ignore], .chat-message-actions, .chat-user-footer, .discussion-msg-actions, .discussion-summary-foot, .discussion-reply-foot, .chat-working, .chat-latest, .chat-older, .chat-skeleton'
const BLOCK = 'div, p, pre, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, article, section'

// Inline Markdown may split a phrase across text nodes; messages and paragraphs never join.
export function chatFindRanges(container: HTMLElement, query: string): Range[] {
  if (!query.trim()) return []
  const groups: Text[][] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let group: Element | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue
    const parent = node.parentElement
    if (!parent || parent.closest(IGNORE) || !parent.getClientRects().length) { group = null; continue }
    const block = parent.closest(BLOCK)
    if (block !== group || groups.length === 0) groups.push([])
    groups[groups.length - 1]?.push(node)
    group = block
  }
  return groups.flatMap((nodes) => {
    const text = nodes.map((node) => node.data).join('')
    const locate = (position: number, end: boolean): { node: Text; offset: number } | null => {
      let before = 0
      for (const node of nodes) {
        const after = before + node.length
        if (position < after || (end && position === after)) return { node, offset: position - before }
        before = after
      }
      return null
    }
    return textMatches(text, query).flatMap((match) => {
      const start = locate(match.start, false)
      const end = locate(match.end, true)
      if (!start || !end) return []
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      return [range]
    })
  })
}

export function nextFindIndex(index: number, direction: number, count: number): number {
  return count > 0 ? (index + direction + count) % count : 0
}
