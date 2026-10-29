import { describe, expect, it } from 'vitest'
import { browserActivity, browserOperation } from './browser-activity'
import { runSummary, toolIconKind } from './chat-tools'

const activity = (name: string, input: string | null = null, title = '') => browserActivity({ name, input, title })

describe('browser tool presentation', () => {
  it.each([
    'mcp__claude-in-chrome__navigate', 'mcp__plugin_claude-in-chrome_claude-in-chrome__navigate',
    'codex_in_edge.navigate', 'cursor_in_firefox.navigate', 'mcp__chrome_devtools__navigate',
    'playwright.browser_navigate', 'mcp__puppeteer__navigate', 'conclave.browser_navigate'
  ])('recognizes %s without depending on the conversation agent', (name) => {
    expect(activity(name)?.action).toBe('navigate')
    expect(toolIconKind(name)).toBe('browser-control')
  })

  it('recognizes a provider supplied as MCP display metadata', () => {
    const display = { server: 'Codex in Edge', name: 'Get Page Text' }
    expect(browserActivity({ name: 'other', display, input: null, title: '' })?.action).toBe('read')
    expect(toolIconKind('other', display)).toBe('browser-control')
    expect(runSummary([{ name: 'other', display }, { name: 'claude_in_chrome.navigate' }])).toBe('浏览器操作 2 次')
  })

  it('does not confuse web fetching, previews or a tool argument with browser control', () => {
    for (const name of ['WebFetch', 'fetch', 'mcp__conclave__show_preview', 'mcp__github__chrome_issue', 'mcp__edgeless__navigate']) {
      expect(browserOperation(name)).toBeNull()
    }
    expect(activity('Bash', '{"url":"https://chrome.example"}', 'Chrome')).toBeNull()
    expect(toolIconKind('mcp__conclave__browser_screenshot')).toBe('image')
  })

  it.each([
    ['browser_click', 'click'], ['browser_type', 'type'], ['browser_scroll', 'scroll'],
    ['browser_take_screenshot', 'screenshot'], ['tabs_context_mcp', 'tabs'],
    ['tabs_close_mcp', 'tabs'], ['getPageText', 'read'], ['browser_wait_for', 'wait'], ['unfamiliar', 'working']
  ])('uses the actual %s action instead of inventing a workflow', (operation, action) => {
    expect(activity(`mcp__claude_in_chrome__${operation}`)?.action).toBe(action)
  })

  it('uses computer-call actions and tolerates partial streaming input', () => {
    expect(activity('claude_in_chrome.computer', '{"action":"left_click"}')?.action).toBe('click')
    expect(activity('claude_in_chrome.computer', '{"action":"type","text":"private"}')?.action).toBe('type')
    expect(activity('claude_in_chrome.computer', '{"action":')?.action).toBe('working')
  })

  it('shows an address without credentials, query data, typed content or file paths', () => {
    expect(activity('playwright.browser_navigate', '{"url":"https://user:secret@example.com/wiki?p=token#private"}')?.address).toBe('example.com/wiki')
    expect(activity('conclave.browser_click', null, 'https://example.com/')?.address).toBe('example.com')
    expect(activity('conclave.browser_type', '{"text":"private"}', 'file:///private/text.txt')?.address).toBeNull()
  })
})
