import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChatItem } from '@conclave/protocol'
import type { ChatRecord, ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { antigravityDialect } from './antigravity-dialect'

// As Antigravity ACP 1.4.1 answered on darwin-arm64 (2026-10-22), trimmed to what Conclave reads.
const initialized = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {} }, auth: { logout: {} } },
  authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'oauth-business', name: 'Log in with Gemini Enterprise' }, { id: 'gemini-api-key', name: 'Gemini API key' }, { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform' }],
  agentInfo: { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.4.1' }
}
const modes = [{ id: 'default', name: 'Default' }, { id: 'auto_edit', name: 'Auto Edit' }, { id: 'yolo', name: 'YOLO' }]
const opened = {
  sessionId: 'dfd164ec-2ebf-4623-8400-51e4627faaad',
  modes: { currentModeId: 'default', availableModes: modes },
  configOptions: [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }] },
    { id: 'thinking_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'default', options: modes.map(({ id, name }) => ({ value: id, name })) }
  ]
}

const Request = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional() })
const items = <K extends ChatItem['kind']>(driver: AcpDriver, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)

function start(options: Partial<ChatStageOptions> = {}) {
  const driver = new AcpDriver(antigravityDialect, 'stage', { cwd: '/project', extraDirs: [], resume: null, ...options })
  const records: ChatRecord[] = []
  const apply = (record: ChatRecord) => { records.push(record); driver.apply(record) }
  const receive = (frame: unknown) => apply({ dir: 'in', at: records.length, frame })
  const due = () => driver.due().map((frame) => { apply({ dir: 'out', at: records.length, frame }); return Request.parse(frame) })
  const sent = [...due()]
  receive({ id: 'antigravity-init', result: initialized })
  sent.push(...due())
  receive({ id: 'antigravity-auth', result: {} })
  sent.push(...due())
  receive({ id: 'antigravity-session', result: opened })
  sent.push(...due())
  return { driver, apply, receive, due, sent }
}

describe('Antigravity ACP', () => {
  it('signs in with Google, then opens a session with Conclave’s MCP server', () => {
    const { driver, sent } = start({ mcp: { command: 'node', args: ['mcp.js'] } })
    expect(sent.map((frame) => frame.method)).toEqual(['initialize', 'authenticate', 'session/new'])
    expect(sent[1]?.params).toEqual({ methodId: 'oauth-personal' })
    expect(sent[2]?.params).toMatchObject({ cwd: '/project', mcpServers: [{ name: 'conclave', command: 'node', args: ['mcp.js'] }] })
    expect(driver.ready()).toBe(true)
    const state = items(driver, 'state').at(-1)
    expect(state?.models.map((model) => model.id)).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro'])
    expect(state?.permissionMode).toBe('ask')
  })

  it('switches to Auto Edit for acceptEdits', () => {
    const { driver, receive, due, sent } = start({ preferred: { permissionMode: 'acceptEdits' } })
    const change = sent.at(-1)
    expect(change?.method).toBe('session/set_config_option')
    expect(change?.params).toMatchObject({ configId: 'mode', value: 'auto_edit' })
    receive({ id: change?.id, result: { configOptions: opened.configOptions.map((config) => config.id === 'mode' ? { ...config, currentValue: 'auto_edit' } : config) } })
    due()
    expect(driver.ready()).toBe(true)
    expect(items(driver, 'state').at(-1)?.permissionMode).toBe('acceptEdits')
  })

  it('refuses to start a stage that must stay read-only, having no such mode', () => {
    const { driver } = start({ readOnly: true })
    expect(driver.ready()).toBe(false)
    expect(driver.failure()).toBeTruthy()
  })

  it('names the other projects only on the wire of its first prompt', () => {
    const { driver } = start({ extraDirs: ['/other'] })
    const { wire, logged } = driver.send('hello')
    expect(JSON.stringify(wire)).toContain('- /other')
    expect(JSON.stringify(logged)).not.toContain('/other')
  })

  it('shows a command by its command line', () => {
    const { driver, apply, receive } = start()
    apply({ dir: 'out', at: 10, frame: driver.send('list the files').logged })
    receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: opened.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls -la', kind: 'execute', status: 'pending', rawInput: { command_line: 'ls -la', working_dir: '/project' } } } })
    receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: opened.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { combinedOutput: 'total 0', exitCode: 0 } } } })
    const tool = items(driver, 'tool').find((item) => item.id === 'tool:t1')
    expect(tool).toMatchObject({ name: 'commandExecution', title: 'ls -la', status: 'done', execution: { status: 'completed', exitCode: 0 } })
    expect(JSON.stringify(tool?.input)).toContain('ls -la')
  })
})
