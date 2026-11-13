import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChatItem } from '@conclave/protocol'
import type { ChatRecord, ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { antigravityDialect } from './antigravity-dialect'

// Shaped after `agy acp --stdio` (1.5.6).
const initialized = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, close: {}, load: {} }, auth: { logout: {} } },
  authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'oauth-business', name: 'Log in with Gemini Enterprise' }, { id: 'gemini-api-key', name: 'Gemini API key' }, { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform' }],
  agentInfo: { name: 'Antigravity ACP Server', title: 'Google Antigravity', version: '1.5.6' }
}
const modes = [
  { id: 'default', name: 'Default' },
  { id: 'accept-edits', name: 'Accept Edits' },
  { id: 'auto', name: 'Auto' },
  { id: 'plan', name: 'Plan' }
]
const opened = {
  sessionId: 'dfd164ec-2ebf-4623-8400-51e4627faaad',
  modes: { currentModeId: 'default', availableModes: modes },
  models: {
    currentModelId: 'gemini-3.1-pro-high',
    availableModels: [
      { modelId: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
      { modelId: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
      { modelId: 'gemini-3-flash-minimal', name: 'Gemini 3 Flash (Minimal)' },
      { modelId: 'gemini-3-flash-high', name: 'Gemini 3 Flash (High)' },
      { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }
    ]
  },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'claude-sonnet-4-6',
      options: [
        { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
        { value: 'gemini-3-flash', name: 'Gemini 3 Flash' }
      ]
    },
    { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: modes.map(({ id, name }) => ({ value: id, name })) }
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
  it('signs in with Google, opens a session with MCP, and preserves per-model variant efforts', () => {
    const { driver, sent } = start({ mcp: { command: 'node', args: ['mcp.js'] } })
    expect(sent.map((frame) => frame.method)).toEqual(['initialize', 'authenticate', 'session/new'])
    expect(sent[1]?.params).toEqual({ methodId: 'oauth-personal' })
    expect(sent[2]?.params).toMatchObject({ cwd: '/project', mcpServers: [{ name: 'conclave', command: 'node', args: ['mcp.js'] }] })
    expect(driver.ready()).toBe(true)
    const state = items(driver, 'state').at(-1)
    expect(state?.models).toEqual([
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: null, efforts: ['low', 'medium', 'high'], isDefault: true },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', description: null, efforts: ['low', 'high'], isDefault: false },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', description: null, efforts: ['minimal', 'high'], isDefault: false }
    ])
    expect(state?.permissionMode).toBe('ask')
  })

  it('switches to Accept Edits for acceptEdits', () => {
    const { driver, receive, due, sent } = start({ preferred: { permissionMode: 'acceptEdits' } })
    const change = sent.at(-1)
    expect(change?.method).toBe('session/set_config_option')
    expect(change?.params).toMatchObject({ configId: 'mode', value: 'accept-edits' })
    receive({ id: change?.id, result: { configOptions: opened.configOptions.map((config) => config.id === 'mode' ? { ...config, currentValue: 'accept-edits' } : config) } })
    due()
    expect(driver.ready()).toBe(true)
    expect(items(driver, 'state').at(-1)?.permissionMode).toBe('acceptEdits')
  })

  it('starts a stage that must stay read-only in plan mode', () => {
    const { driver, receive, due, sent } = start({ readOnly: true })
    const change = sent.at(-1)
    expect(change?.method).toBe('session/set_config_option')
    expect(change?.params).toMatchObject({ configId: 'mode', value: 'plan' })
    receive({ id: change?.id, result: { configOptions: opened.configOptions.map((config) => config.id === 'mode' ? { ...config, currentValue: 'plan' } : config) } })
    due()
    expect(driver.ready()).toBe(true)
    const state = items(driver, 'state').at(-1)
    expect(state?.permissionMode).toBe('plan')
    expect(state?.permissionModes).toEqual(['plan'])
    expect(() => driver.setOption('permissionMode', 'acceptEdits')).toThrow('只读成员不能换模式')
  })

  it('names the other projects only on the wire of its first prompt when additionalDirectories is unsupported', () => {
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

  it('supports agy 1.5.6 modes, native additionalDirectories, and slash command updates', () => {
    const driver = new AcpDriver(antigravityDialect, 'stage-156', {
      cwd: '/project',
      extraDirs: ['/extra-repo'],
      resume: null,
      preferred: { permissionMode: 'plan' }
    })
    const records: ChatRecord[] = []
    const apply = (record: ChatRecord) => { records.push(record); driver.apply(record) }
    const receive = (frame: unknown) => apply({ dir: 'in', at: records.length, frame })
    const due = () => driver.due().map((frame) => { apply({ dir: 'out', at: records.length, frame }); return Request.parse(frame) })

    due()
    receive({
      id: 'antigravity-init',
      result: {
        ...initialized,
        agentCapabilities: {
          ...initialized.agentCapabilities,
          sessionCapabilities: { list: {}, resume: {}, close: {}, load: {}, additionalDirectories: {} }
        }
      }
    })
    due()
    receive({ id: 'antigravity-auth', result: {} })
    const sessionRequests = due()
    expect(sessionRequests[0]?.method).toBe('session/new')
    expect(sessionRequests[0]?.params).toMatchObject({ cwd: '/project', additionalDirectories: ['/extra-repo'] })

    receive({
      id: 'antigravity-session',
      result: opened
    })
    const modeSwitch = due()
    expect(modeSwitch[0]?.params).toMatchObject({ configId: 'mode', value: 'plan' })
    receive({
      id: modeSwitch[0]?.id,
      result: {
        configOptions: opened.configOptions.map((entry) => entry.id === 'mode' ? { ...entry, currentValue: 'plan' } : entry)
      }
    })
    due()
    receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: opened.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: 'Compact conversation context' }]
        }
      }
    })

    expect(driver.ready()).toBe(true)
    const state = items(driver, 'state').at(-1)
    expect(state?.permissionMode).toBe('plan')
    expect(state?.permissionModes).toEqual(['ask', 'acceptEdits', 'bypass', 'plan'])
    expect(state?.commands).toEqual([{ name: 'compact', description: 'Compact conversation context', argumentHint: null }])

    // Because 1.5.6 accepts `additionalDirectories` natively in `session/new`, the first prompt is untampered.
    const { wire } = driver.send('hello')
    expect(JSON.stringify(wire)).not.toContain('/extra-repo')
  })
})
