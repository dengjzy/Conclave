import { describe, expect, it } from 'vitest'
import { describeBrowserPage, describeClosedTab, type ChatItem } from '@conclave/protocol'
import { browserRunTabs } from './chat-browser'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const tabId = '10dbacd0-d598-495a-997a-498a87d1e70e'
const otherId = '20dbacd0-d598-495a-997a-498a87d1e70e'
const page = (url: string, id = tabId, closed = false) => ({ id, title: url, url, closed })
const call = (id: string, url: string, changes: Partial<ToolItem> = {}): ToolItem => ({
  id, stageId: 'stage', revision: 1, at: 0, kind: 'tool', name: 'conclave.browser_navigate',
  title: url, input: null, output: describeBrowserPage(page(url), 'snapshot'), status: 'done', diffs: [], ...changes
})
const close = (id: string, tab: string): ToolItem => call(id, '', { name: 'conclave.browser_tabs', output: describeClosedTab(tab) })

describe('browserRunTabs', () => {
  it('keeps a tab at its latest successful page, even across different URLs and refreshes', () => {
    const tools = [call('a', 'http://localhost/preview?model=auto'), call('b', 'http://localhost/preview?model=sonnet'),
      call('c', 'http://localhost/other'), call('d', 'http://localhost/other')]
    expect(browserRunTabs(tools)).toEqual({ tabs: [page('http://localhost/other')], current: page('http://localhost/other') })
  })

  it('uses snapshots and interactions to update a page reached without an explicit navigation', () => {
    const tools = [call('a', 'http://localhost/', { name: 'conclave.browser_tabs' }),
      call('b', 'http://localhost/next', { name: 'mcp__conclave__browser_click' }),
      call('c', 'http://localhost/final', { name: 'conclave.browser_snapshot' })]
    expect(browserRunTabs(tools).tabs).toEqual([page('http://localhost/final')])
  })

  it('keeps tabs apart even when their URLs match, in the order they came up, the last acted on current', () => {
    const other = page('http://localhost/', otherId)
    const tools = [call('a', other.url), call('b', other.url, { output: describeBrowserPage(other, null) }), call('c', other.url)]
    expect(browserRunTabs(tools)).toMatchObject({ tabs: [{ id: tabId }, { id: otherId }], current: { id: tabId } })
  })

  it('keeps closed tabs and the last viewed page, including after every tab closes', () => {
    const tools = [call('a', 'http://localhost/'), call('b', 'http://localhost/', { output: describeBrowserPage(page('http://localhost/', otherId), null) })]
    expect(browserRunTabs([...tools, close('c', otherId)])).toEqual({ tabs: [page('http://localhost/'), page('http://localhost/', otherId, true)], current: page('http://localhost/', otherId, true) })
    expect(browserRunTabs([...tools, close('c', otherId), close('d', tabId)])).toEqual({ tabs: [page('http://localhost/', tabId, true), page('http://localhost/', otherId, true)], current: page('http://localhost/', otherId, true) })
  })

  it.each(['running', 'failed', 'denied', 'interrupted'] as const)('does not replace a successful page with a %s result', (status) => {
    const good = call('good', 'http://localhost/')
    expect(browserRunTabs([good, call('bad', 'http://localhost/bad', { status })]).tabs).toEqual([page('http://localhost/')])
  })

  it('uses live tab existence for closes outside this turn, retaining the historical title and URL', () => {
    const tools = [call('a', 'http://localhost/first')]
    expect(browserRunTabs(tools).current?.closed).toBe(false)
    expect(browserRunTabs(tools, []).current).toEqual(page('http://localhost/first', tabId, true))
    expect(browserRunTabs(tools, [{ id: tabId }]).current).toEqual(page('http://localhost/first'))
    expect(browserRunTabs(tools, [{ id: otherId }]).tabs).toEqual([page('http://localhost/first', tabId, true)])
  })

  it('ignores unsuccessful closes and accepts a later successful page for the same tab', () => {
    const first = call('a', 'http://localhost/')
    const closed = close('c', tabId)
    expect(browserRunTabs([first, { ...closed, status: 'failed' }]).current?.closed).toBe(false)
    expect(browserRunTabs([first, closed, call('b', 'http://localhost/next')]).current).toEqual(page('http://localhost/next'))
    expect(browserRunTabs([closed])).toEqual({ tabs: [], current: null })
  })

  it('does not invent pages from refusals, missing outputs or unrelated tool results', () => {
    expect(browserRunTabs([
      call('gate', '', { output: '等待用户确认' }), call('empty', '', { output: null }),
      call('cmd', 'http://localhost/', { name: 'Bash' })
    ])).toEqual({ tabs: [], current: null })
  })
})
