import { browserToolKind, parseBrowserPage, parseClosedTab, type BrowserTab, type ChatItem } from '@conclave/protocol'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
export type RunTab = Pick<BrowserTab, 'id' | 'url' | 'title'> & { closed: boolean }
export type RunTabs = { tabs: RunTab[]; current: RunTab | null }

// Keep each tab's last successful page even after closure. Live tabs decide whether it can still
// open; before the watch answers, only an explicit successful close proves it closed.
export function browserRunTabs(tools: readonly ToolItem[], liveTabs?: readonly Pick<BrowserTab, 'id'>[]): RunTabs {
  const pages = new Map<string, Pick<BrowserTab, 'id' | 'url' | 'title'>>()
  const closed = new Set<string>()
  let current: string | null = null
  for (const item of tools) {
    if (!browserToolKind(item.name) || item.status !== 'done' || !item.output) continue
    const gone = parseClosedTab(item.output)
    if (gone) {
      closed.add(gone)
      continue
    }
    const page = parseBrowserPage(item.output)
    if (!page) continue
    pages.set(page.id, page)
    closed.delete(page.id)
    current = page.id
  }
  const live = liveTabs === undefined ? null : new Set(liveTabs.map((tab) => tab.id))
  const tabs = [...pages.values()].map((page) => ({ ...page, closed: live ? !live.has(page.id) : closed.has(page.id) }))
  return { tabs, current: tabs.find((tab) => tab.id === current) ?? null }
}

// The host a URL names, with its path; the URL itself when it is not one.
export function hostLine(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host ? `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}` : url
  } catch {
    return url
  }
}
