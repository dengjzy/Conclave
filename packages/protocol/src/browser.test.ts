import { describe, expect, it } from 'vitest'
import { browserHostOf, describeBrowserPage, describeClosedTab, isLocalHost, normalizeBrowserUrl, parseBrowserPage, parseClosedTab } from './browser'
import { browserToolKind, imageMarker, isConclaveRequest, isBrowserTool, isPreviewImage, isPreviewTool, conclaveToolName, takeImageMarkers, toolImagePath } from './chat'
import { McpServerName } from './mcp'
import { isTerminalRunTool } from './terminal'

describe('isLocalHost', () => {
  it('takes the names a developer serves on', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1', 'app.localhost', 'api.test']) {
      expect(isLocalHost(host), host).toBe(true)
    }
  })

  it('refuses everything else, including names that merely contain a local one', () => {
    for (const host of ['example.com', 'localhost.evil.com', 'evil.localhost.com', '127.0.0.1.nip.io', 'test', 'mytest.dev']) {
      expect(isLocalHost(host), host).toBe(false)
    }
  })
})

describe('tool names', () => {
  it('reads Conclave tools as either agent names them', () => {
    expect(conclaveToolName('mcp__conclave__browser_click')).toBe('browser_click')
    expect(conclaveToolName('conclave.show_preview')).toBe('show_preview')
    expect(conclaveToolName('Bash')).toBeNull()
    expect(conclaveToolName('mcp__other__browser_click')).toBeNull()
    expect(isPreviewTool('conclave.show_preview')).toBe(true)
  })

  it('reads its own requests, image markers and server name as Conclave writes them', () => {
    expect(isTerminalRunTool('conclave_terminal_run')).toBe(true)
    expect(isConclaveRequest('conclave:browser-host:1')).toBe(true)
    expect(isConclaveRequest('toolu_1')).toBe(false)
    const id = `${'c'.repeat(64)}.png`
    expect(takeImageMarkers(`[conclave-image ${id} 2x1]`).images).toEqual([{ id, width: 2, height: 1 }])
    expect(McpServerName.safeParse('conclave').success).toBe(false)
  })

  it('shows a picture a call looked at on disk from the file, for a Read, a view_image or an image_gen alone', () => {
    expect(toolImagePath({ name: 'Read', title: '/tmp/shot.png' })).toBe('/tmp/shot.png')
    expect(toolImagePath({ name: 'Read', title: 'C:\\tmp\\shot.png' })).toBe('C:\\tmp\\shot.png')
    expect(toolImagePath({ name: 'imageView', title: '/tmp/shot.JPG' })).toBe('/tmp/shot.JPG')
    expect(toolImagePath({ name: 'imageGeneration', title: '/tmp/drawn.png' })).toBe('/tmp/drawn.png')
    expect(toolImagePath({ name: 'imageGeneration', title: '' })).toBeNull()
    expect(toolImagePath({ name: 'Read', title: '/tmp/notes.md' })).toBeNull()
    expect(toolImagePath({ name: 'Read', title: 'shot.png' })).toBeNull()
    expect(toolImagePath({ name: 'Bash', title: '/tmp/shot.png' })).toBeNull()
  })

  it('shows a picture as an image and a page or an SVG in a frame', () => {
    expect(isPreviewImage('/tmp/shot.PNG')).toBe(true)
    expect(isPreviewImage('/tmp/chart.webp')).toBe(true)
    expect(isPreviewImage('/tmp/chart.svg')).toBe(false)
    expect(isPreviewImage('/tmp/index.html')).toBe(false)
  })

  it('knows the browser tools and no other', () => {
    expect(browserToolKind('mcp__conclave__browser_navigate')).toBe('navigate')
    expect(browserToolKind('conclave.browser_tabs')).toBe('tabs')
    expect(browserToolKind('conclave.browser_fly')).toBeNull()
    expect(browserToolKind('mcp__conclave__show_preview')).toBeNull()
    expect(isBrowserTool('conclave.browser_click')).toBe(true)
    expect(isBrowserTool('Edit')).toBe(false)
  })
})

describe('image markers', () => {
  const id = `${'a'.repeat(64)}.jpg`

  it('round-trips an image through a text block', () => {
    const text = `截图已保存\n${imageMarker({ id, width: 1280, height: 800 })}`
    expect(takeImageMarkers(text)).toEqual({ text: '截图已保存', images: [{ id, width: 1280, height: 800 }] })
  })

  it('takes several markers and leaves the rest of the text as it was', () => {
    const other = `${'b'.repeat(64)}.png`
    const text = `${imageMarker({ id, width: 1, height: 2 })}\n\n一段说明\n${imageMarker({ id: other, width: 3, height: 4 })}\n`
    const taken = takeImageMarkers(text)
    expect(taken.images).toEqual([{ id, width: 1, height: 2 }, { id: other, width: 3, height: 4 }])
    expect(taken.text).toBe('一段说明')
  })

  it('returns text without markers untouched', () => {
    expect(takeImageMarkers('[conclave-image nope 1x1]\nplain')).toEqual({ text: '[conclave-image nope 1x1]\nplain', images: [] })
  })
})
describe('normalizeBrowserUrl', () => {
  it('leaves a URL with a scheme alone and gives the rest one', () => {
    expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
    expect(normalizeBrowserUrl('example.com/path')).toBe('https://example.com/path')
  })

  it('sends a bare local address to http, and names the host a URL goes to', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeBrowserUrl('127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000/app')
    expect(normalizeBrowserUrl(' localhost ')).toBe('http://localhost')
    expect(browserHostOf('example.com/x')).toBe('example.com')
    expect(browserHostOf('about:blank')).toBeNull()
    expect(browserHostOf('data:text/html,hi')).toBeNull()
  })
})

describe('browser page text', () => {
  const tab = { id: '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e', url: 'http://localhost:5173/', title: 'Conclave 测试页' }

  it('reads the page back out of what the tool told the model', () => {
    expect(parseBrowserPage(describeBrowserPage(tab, '- heading [ref=e1]'))).toEqual(tab)
    expect(parseBrowserPage(describeBrowserPage({ ...tab, title: '' }, null))).toEqual({ ...tab, title: '' })
    expect(parseBrowserPage('用户拒绝了访问 example.com。')).toBeNull()
  })

  it('reads a closed tab back, and nothing else as one', () => {
    expect(parseClosedTab(describeClosedTab(tab.id))).toBe(tab.id)
    expect(parseClosedTab(describeBrowserPage(tab, null))).toBeNull()
  })
})
