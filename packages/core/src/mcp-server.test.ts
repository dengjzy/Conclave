import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPreviewFile, conversationToolLimits, createMcpHandler } from './mcp-server'

const frame = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
const notification = (method: string) => JSON.stringify({ jsonrpc: '2.0', method })

describe('conclave MCP server', () => {
  const handle = createMcpHandler({ preview: checkPreviewFile })

  it('acknowledges startup only after initialize and restricts a planning server to read-only tools', async () => {
    let initialized = false
    const readOnly = createMcpHandler({
      preview: checkPreviewFile, planOnly: true,
      initialized: async () => { initialized = true },
      terminal: { call: async () => ({ text: 'read' }) }
    })
    const listed = await readOnly(frame('tools/list'))
    expect(initialized).toBe(false)
    expect(listed?.result).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: 'show_preview' }), expect.objectContaining({ name: 'terminal_read' })]) })
    for (const name of ['terminal_run', 'terminal_stop']) {
      expect((await readOnly(frame('tools/call', { name, arguments: {} })))?.error?.code).toBe(-32602)
    }
    await readOnly(frame('initialize'))
    expect(initialized).toBe(true)
  })

  it('reports the tools listed, for an agent that offers them only once it has listed them', async () => {
    let listed = 0
    const server = createMcpHandler({ preview: checkPreviewFile, listed: async () => { listed++ } })
    await server(frame('initialize'))
    expect(listed).toBe(0)
    expect((await server(frame('tools/list')))?.result).toMatchObject({ tools: expect.any(Array) })
    expect(listed).toBe(1)
  })

  it('gives a group chat member only read-only tools', () => {
    expect(conversationToolLimits({ discussionId: 'group' })).toEqual({ readOnly: true })
    expect(conversationToolLimits({ workspaceReadOnly: true })).toEqual({ readOnly: true })
    expect(conversationToolLimits({})).toEqual({ readOnly: false })
  })

  it('answers the handshake with the client version and a tools capability', async () => {
    const response = await handle(frame('initialize', { protocolVersion: '2025-03-26', capabilities: {} }))
    expect(response?.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} } })
    expect(await handle(notification('notifications/initialized'))).toBeNull()
  })

  it('lists the preview tool alone without a conversation', async () => {
    const response = await handle(frame('tools/list'))
    expect(response?.result).toEqual({ tools: [expect.objectContaining({ name: 'show_preview', annotations: expect.objectContaining({ readOnlyHint: true }) })] })
  })

  it('adds the terminal tools for a conversation and checks their arguments', async () => {
    const called: Array<[string, unknown]> = []
    const chat = createMcpHandler({
      preview: checkPreviewFile,
      terminal: {
        call: async (kind, args) => {
          called.push([kind, args])
          return { text: `did ${kind}` }
        }
      }
    })
    const listed = (await chat(frame('tools/list')))?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }
    expect(listed.tools.map((tool) => tool.name)).toEqual(['show_preview', 'terminal_run', 'terminal_read', 'terminal_stop'])
    expect(listed.tools.find((tool) => tool.name === 'terminal_read')?.annotations.readOnlyHint).toBe(true)
    const bad = await chat(frame('tools/call', { name: 'terminal_read', arguments: { id: 'nope' } }))
    expect(bad?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('参数不对') }] })
    expect(called).toEqual([])
    const run = await chat(frame('tools/call', { name: 'terminal_run', arguments: { command: 'pnpm test' } }))
    expect(run?.result).toEqual({ content: [{ type: 'text', text: 'did run' }], isError: false })
    expect(called).toEqual([['run', { command: 'pnpm test' }]])
  })

  it('shows an HTML file or a picture that exists, and refuses anything else', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-preview-'))
    try {
      const page = path.join(dir, 'index.html')
      writeFileSync(page, '<h1>hi</h1>')
      const ok = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: page } }))
      expect(ok?.result).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('页面') }] })
      const shot = path.join(dir, 'Shot.PNG')
      writeFileSync(shot, 'png bytes')
      const picture = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: shot } }))
      expect(picture?.result).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('图片') }] })
      const missing = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: path.join(dir, 'gone.html') } }))
      expect(missing?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('文件不存在') }] })
      const other = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: path.join(dir, 'notes.md') } }))
      expect(other?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('.png') }] })
      const relative = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: 'index.html' } }))
      expect(relative?.result).toMatchObject({ isError: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects unknown tools, unknown methods and garbage', async () => {
    expect((await handle(frame('tools/call', { name: 'rm_rf' })))?.error?.code).toBe(-32602)
    expect((await handle(frame('resources/list')))?.error?.code).toBe(-32601)
    expect((await handle('{oops'))?.error?.code).toBe(-32700)
  })
})
