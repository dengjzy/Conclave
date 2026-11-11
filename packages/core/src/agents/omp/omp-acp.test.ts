import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChatItem } from '@conclave/protocol'
import { AcpDriver } from '../acp/acp-driver'
import type { ChatStageOptions } from '../../chat-driver'
import { ompDialect } from './omp-dialect'

const INIT = {
  protocolVersion: 1,
  agentInfo: { name: 'omp', title: 'omp', version: '18.18.8' },
  authMethods: [{ id: 'agent', name: 'Use existing local credentials', description: 'Authenticate via provider keys or OAuth state under ~/.omp.' }],
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} }
  }
}
const OPENED = {
  sessionId: 'provider-session',
  configOptions: [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [
      { value: 'default', name: 'Default', description: 'Standard ACP headless mode' },
      { value: 'plan', name: 'Plan', description: 'Read-only planning mode' }
    ] },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'deepseek/deepseek-flash', options: [
      { value: 'deepseek/deepseek-flash', name: 'DeepSeek-V4.1-Flash', description: 'deepseek/deepseek-flash' },
      { value: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'deepseek/deepseek-v4-pro' }
    ] },
    { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'max', options: [
      { value: 'off', name: 'Off' }, { value: 'auto', name: 'Auto' }, { value: 'low', name: 'low' }, { value: 'high', name: 'high' }, { value: 'max', name: 'max' }
    ] }
  ]
}
const options: ChatStageOptions = { cwd: '/work', extraDirs: [], resume: null }
const items = <K extends ChatItem['kind']>(driver: AcpDriver, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)
const receive = (driver: AcpDriver, frame: unknown) => driver.apply({ dir: 'in', at: 100, frame })
function opened(extra: Partial<ChatStageOptions> = {}) {
  const driver = new AcpDriver(ompDialect, 'stage', { ...options, ...extra })
  const SentFrame = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional() })
  const sent: Array<z.infer<typeof SentFrame>> = []
  const flush = () => {
    const frames = driver.due()
    for (const frame of frames) {
      sent.push(SentFrame.parse(frame))
      driver.apply({ dir: 'out', at: 101, frame })
    }
  }
  flush()
  receive(driver, { id: 'omp-init', result: INIT })
  flush()
  receive(driver, { id: 'omp-auth', result: {} })
  flush()
  receive(driver, { id: 'omp-session', result: OPENED })
  flush()
  return { driver, sent }
}

describe('omp ACP', () => {
  it('authenticates with its existing credentials and opens an accept-edits session', () => {
    const { driver, sent } = opened()
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 'omp-auth', method: 'authenticate', params: { methodId: 'agent' } })
    expect(sent).toContainEqual(expect.objectContaining({ id: 'omp-session', method: 'session/new', params: { cwd: '/work', mcpServers: [] } }))
    expect(driver.ready()).toBe(true)
    expect(items(driver, 'state').at(-1)).toMatchObject({
      permissionMode: 'acceptEdits', permissionModes: ['acceptEdits'],
      model: 'deepseek/deepseek-flash', effort: 'max',
      models: [
        { id: 'deepseek/deepseek-flash', isDefault: true, efforts: ['off', 'auto', 'low', 'high', 'max'] },
        { id: 'deepseek/deepseek-v4-pro', isDefault: false, efforts: [] }
      ]
    })
    // Plan is omp's own, but it leaves it by itself; Conclave must not offer it as a safe mode.
    expect(() => driver.setOption('permissionMode', 'plan')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
  })

  it('sends Conclave and user MCP servers when the session opens', () => {
    const { sent } = opened({
      mcp: { command: 'node', args: ['mcp.js'], env: { SCOPE: 'chat' } },
      userMcp: [{ type: 'http', name: 'docs', url: 'https://example.com/mcp' }]
    })
    expect(sent.find((frame) => frame.id === 'omp-session')).toMatchObject({
      params: { mcpServers: [
        { name: 'conclave', command: 'node', args: ['mcp.js'], env: [{ name: 'SCOPE', value: 'chat' }] },
        { type: 'http', name: 'docs', url: 'https://example.com/mcp', headers: [] }
      ] }
    })
  })

  it('shows a command approval, keeps its MCP tool name, and accounts for cache reads', () => {
    const { driver } = opened()
    driver.apply({ dir: 'out', at: 102, frame: driver.send('run printf ok').logged })
    receive(driver, { method: 'session/update', params: { sessionId: 'provider-session', update: {
      sessionUpdate: 'tool_call', toolCallId: 'call', name: 'bash', title: '$ printf ok', kind: 'execute', status: 'pending',
      rawInput: { command: 'printf ok', timeout: 30, cwd: '/work' }, content: [{ type: 'content', content: { type: 'text', text: '$ printf ok' } }]
    } } })
    receive(driver, { id: 7, method: 'session/request_permission', params: {
      sessionId: 'provider-session',
      toolCall: { toolCallId: 'call', title: 'printf ok', kind: 'execute', status: 'pending', rawInput: { command: 'printf ok' }, content: [{ type: 'content', content: { type: 'text', text: '$ printf ok' } }] },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }
      ]
    } })
    const approval = items(driver, 'approval')[0]!
    expect(approval).toMatchObject({ tool: 'commandExecution', title: 'printf ok', toolItemId: 'tool:call', resolution: null })
    expect(driver.respond(approval.requestId, { decision: 'allow' })).toContainEqual({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } })

    receive(driver, { method: 'session/update', params: { sessionId: 'provider-session', update: {
      sessionUpdate: 'tool_call', toolCallId: 'mcp', name: 'mcp__conclave__terminal_run', title: 'mcp__conclave__terminal_run', kind: 'other', status: 'completed',
      rawInput: { command: 'git status' }, content: [{ type: 'content', content: { type: 'text', text: 'clean' } }]
    } } })
    expect(items(driver, 'tool').find((item) => item.id === 'tool:mcp')).toMatchObject({ name: 'conclave.terminal_run', title: 'git status' })

    receive(driver, { method: 'session/update', params: { sessionId: 'provider-session', update: { sessionUpdate: 'usage_update', size: 1_000_000, used: 9_065, cost: { amount: 0.00061728, currency: 'USD' } } } })
    receive(driver, { id: 'omp-prompt-1', result: { stopReason: 'end_turn', usage: { inputTokens: 564, outputTokens: 287, totalTokens: 18_131, cachedReadTokens: 17_280 } } })
    expect(items(driver, 'turn').at(-1)).toMatchObject({
      state: 'completed',
      usage: { input: 17_844, output: 287 },
      metering: { models: [{ model: 'deepseek/deepseek-flash', input: 17_844, output: 287, cacheRead: 17_280, costUsd: 0.000617 }], reportedCostUsd: 0.000617 }
    })
    expect(items(driver, 'state').at(-1)?.context).toEqual({ used: 9_065, window: 1_000_000 })
  })
})
