import { localized, t } from './i18n'
import { browserToolKind, type ChatItem } from '@conclave/protocol'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type ToolDisplay = ToolItem['display']
export type BrowserAction = 'navigate' | 'read' | 'click' | 'type' | 'scroll' | 'screenshot' | 'tabs' | 'wait' | 'working'

const BROWSER_PROVIDER = /(?:^|_)(?:chrome|chromium|edge|firefox|safari|brave|browser|playwright|puppeteer|browserbase)(?:_|$)/
const ACTION_LABEL: Record<BrowserAction, string> = localized(() => ({
  navigate: t('browserActivity.openingPage'), read: t('browserActivity.readingPage'), click: t('browserActivity.interactingWithPage'),
  type: t('browserActivity.typing'), scroll: t('browserActivity.scrolling'), screenshot: t('browserActivity.takingScreenshot'),
  tabs: t('browserActivity.managingTabs'), wait: t('browserActivity.waitingForPage'), working: t('browserActivity.usingBrowser')
}))

function normalized(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

// Presentation only: third-party browser calls must not acquire Conclave's tab ownership or routing.
export function browserOperation(name: string, display?: ToolDisplay): string | null {
  const own = browserToolKind(name)
  if (own) return own
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  const dot = name.indexOf('.')
  const provider = mcp?.[1] ?? (dot > 0 ? name.slice(0, dot) : '')
  const operation = mcp?.[2] ?? (dot > 0 ? name.slice(dot + 1) : name)
  if (BROWSER_PROVIDER.test(normalized(provider))) return normalized(operation)
  if (display?.server && BROWSER_PROVIDER.test(normalized(display.server))) return normalized(display.name)
  return null
}

export function browserActivity(tool: Pick<ToolItem, 'name' | 'display' | 'input' | 'title'>): { action: BrowserAction; label: string; address: string | null } | null {
  const operation = browserOperation(tool.name, tool.display)
  if (operation === null) return null
  let input: unknown = null
  try { input = JSON.parse(tool.input ?? 'null') } catch { /* Partial streamed input has no action yet. */ }
  const inputAction = input && typeof input === 'object' && 'action' in input && typeof input.action === 'string' ? normalized(input.action) : ''
  const tokens = `${operation}_${inputAction}`.split('_')
  const has = (...words: string[]) => words.some((word) => tokens.includes(word))
  const action: BrowserAction = has('screenshot') ? 'screenshot'
    : has('navigate', 'navigation', 'goto', 'open', 'launch') ? 'navigate'
    : has('scroll') ? 'scroll'
    : has('type', 'typing', 'fill', 'input', 'press', 'key') ? 'type'
    : has('click', 'hover', 'select', 'drag') ? 'click'
    : has('tabs', 'tab') ? 'tabs'
    : has('wait') ? 'wait'
    : has('snapshot', 'text', 'read', 'evaluate', 'console', 'inspect') ? 'read' : 'working'
  const url = input && typeof input === 'object' && 'url' in input && typeof input.url === 'string' ? input.url : tool.title
  let address: string | null = null
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') address = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch { /* A tool title is usually an action, not an address. */ }
  return { action, label: ACTION_LABEL[action], address }
}
