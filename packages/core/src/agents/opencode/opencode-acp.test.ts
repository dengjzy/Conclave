import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { conclaveToolName, ChatItem } from '@conclave/protocol'
import type { ChatStageOptions } from '../../chat-driver'
import { OpenCodeAcp } from './opencode-acp'
import { parseChatRecord } from '../../chat-log'

// Frames as OpenCode 2.1's ACP (packages/cli/src/acp) sends them: capabilities named by objects,
// its primary agents, models and effort as session config options, and tool calls with a name.
const OPTIONS: ChatStageOptions = { cwd: '/work/repo', extraDirs: ['/work/other'], resume: null, mcp: { command: 'node', args: ['mcp.mjs'] } }
const INITIALIZED = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: false },
    promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, resume: {} },
    _meta: { 'opencode/child-session-updates': true }
  },
  authMethods: [{ id: 'opencode-login', name: 'Login with opencode', description: 'Run `opencode auth login` in the terminal' }],
  agentInfo: { name: 'OpenCode', version: '2.1.1' }
}
const config = (model = 'anthropic/claude-sonnet-5-5', mode = 'build') => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'anthropic/claude-sonnet-5-5', name: 'anthropic/Claude Sonnet 5.5' }, { value: 'openai/gpt-6', name: 'openai/GPT-6' }] },
  ...(model.startsWith('anthropic/') ? [{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default', options: [{ value: 'high', name: 'High' }, { value: 'default', name: 'Default' }] }] : []),
  { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }, { value: 'conclave-readonly', name: 'conclave-readonly' }] }
]
const Request = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional() })
const receive = (driver: OpenCodeAcp, frame: unknown, at = 2) => driver.apply({ dir: 'in', at, frame })
const due = (driver: OpenCodeAcp) => {
  const frames = driver.due()
  frames.forEach((frame) => driver.apply({ dir: 'out', at: 1, frame }))
  return frames.map((frame) => Request.parse(frame))
}
const update = (driver: OpenCodeAcp, content: unknown) => receive(driver, { method: 'session/update', params: { sessionId: 'ses_1', update: content } })
const items = <K extends ChatItem['kind']>(driver: OpenCodeAcp, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)

function opened(options: ChatStageOptions = OPTIONS): OpenCodeAcp {
  const driver = new OpenCodeAcp('stage', options)
  due(driver)
  receive(driver, { id: 'opencode-init', result: INITIALIZED })
  expect(due(driver).map((frame) => frame.method)).toEqual(['authenticate'])
  receive(driver, { id: 'opencode-auth', result: {} })
  const [session] = due(driver)
  // Conclave's own MCP server rides in its config instead (opencodeConfig), where Code Mode can be off.
  expect(session).toMatchObject({ method: 'session/new', params: { cwd: '/work/repo', additionalDirectories: ['/work/other'], mcpServers: [] } })
  receive(driver, { id: 'opencode-session', result: { sessionId: 'ses_1', configOptions: config() } })
  return driver
}

describe('OpenCode over ACP', () => {
  it('opens a session with its login and extra folders, and reads its config', () => {
    const driver = opened()
    expect(driver.ready()).toBe(true)
    expect(driver.failure()).toBeNull()
    expect(driver.providerSessionId()).toBe('ses_1')
    expect(items(driver, 'state').at(-1)).toMatchObject({
      permissionMode: 'ask',
      permissionModes: ['ask', 'plan', 'readOnly'],
      model: 'anthropic/claude-sonnet-5-5',
      effort: 'default',
      models: [expect.objectContaining({ id: 'anthropic/claude-sonnet-5-5', efforts: ['high', 'default'] }), expect.objectContaining({ id: 'openai/gpt-6' })]
    })
  })

  it('switches mode, model and effort through its config options', () => {
    const driver = opened()
    expect(Request.parse(driver.setOption('permissionMode', 'readOnly')[0])).toMatchObject({ method: 'session/set_config_option', params: { configId: 'mode', value: 'conclave-readonly' } })
    expect(Request.parse(driver.setOption('effort', 'high')[0])).toMatchObject({ method: 'session/set_config_option', params: { configId: 'effort', value: 'high' } })
    const [model] = driver.setOption('model', 'openai/gpt-6')
    driver.apply({ dir: 'out', at: 3, frame: model })
    expect(Request.parse(model)).toMatchObject({ method: 'session/set_config_option', params: { configId: 'model', value: 'openai/gpt-6' } })
    // The new model has no effort levels: the previous one's level goes with it.
    receive(driver, { id: Request.parse(model).id, result: { configOptions: config('openai/gpt-6') } })
    expect(items(driver, 'state').at(-1)).toMatchObject({ model: 'openai/gpt-6', effort: null })
  })

  it('starts a read-only stage in the agent Conclave adds for it', () => {
    const driver = new OpenCodeAcp('stage', { ...OPTIONS, readOnly: true, preferred: { permissionMode: 'readOnly' } })
    due(driver)
    receive(driver, { id: 'opencode-init', result: INITIALIZED })
    due(driver)
    receive(driver, { id: 'opencode-auth', result: {} })
    due(driver)
    receive(driver, { id: 'opencode-session', result: { sessionId: 'ses_1', configOptions: config() } })
    const [initial] = due(driver)
    expect(initial).toMatchObject({ method: 'session/set_config_option', params: { configId: 'mode', value: 'conclave-readonly' } })
    receive(driver, { id: initial!.id, result: { configOptions: config(undefined, 'conclave-readonly') } })
    expect(driver.ready()).toBe(true)
    expect(items(driver, 'state').at(-1)).toMatchObject({ permissionMode: 'readOnly', permissionModes: ['readOnly'] })
  })

  it('runs a turn: shell by its kind, Conclave\'s tools by Conclave\'s names, others by their own', () => {
    const driver = opened()
    const message = driver.send('show me')
    driver.apply({ dir: 'out', at: 3, frame: message.logged })

    update(driver, { sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'shell', title: 'pnpm test', kind: 'execute', status: 'pending', rawInput: { command: 'pnpm test' } })
    receive(driver, { id: 4, method: 'session/request_permission', params: { sessionId: 'ses_1', toolCall: { toolCallId: 'call_1', name: 'shell', title: 'pnpm test', kind: 'execute', status: 'pending' }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] } })
    const [approval] = items(driver, 'approval')
    expect(approval).toMatchObject({ tool: 'commandExecution', choices: [expect.objectContaining({ id: 'once', decision: 'allow' }), expect.objectContaining({ id: 'always', decision: 'allowForSession' }), expect.objectContaining({ id: 'reject', decision: 'deny' })] })
    driver.respond(approval!.requestId, { decision: 'allow', choice: 'always' }).forEach((frame) => driver.apply({ dir: 'out', at: 4, frame }))
    update(driver, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress', kind: 'execute', title: 'pnpm test' })
    update(driver, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', rawOutput: {} })

    update(driver, { sessionUpdate: 'tool_call', toolCallId: 'call_2', name: 'conclave_show_preview', title: 'conclave_show_preview', kind: 'other', status: 'pending', rawInput: { path: '/work/repo/out.png' } })
    update(driver, { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'in_progress', kind: 'other' })
    update(driver, { sessionUpdate: 'tool_call', toolCallId: 'call_3', name: 'todowrite', title: 'todowrite', kind: 'other', status: 'pending', rawInput: {} })
    update(driver, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
    receive(driver, { id: 'opencode-prompt-1', result: { stopReason: 'end_turn' } })

    const tools = items(driver, 'tool')
    expect(tools.map((tool) => tool.name)).toEqual(['commandExecution', 'conclave.show_preview', 'todowrite'])
    expect(conclaveToolName(tools[1]!.name)).toBe('show_preview')
    expect(items(driver, 'turn')[0]).toMatchObject({ state: 'completed', error: null })
  })

  it('resumes a session by loading it, where OpenCode answers with its config alone', () => {
    const driver = new OpenCodeAcp('stage', { ...OPTIONS, resume: 'ses_1' })
    due(driver)
    receive(driver, { id: 'opencode-init', result: INITIALIZED })
    due(driver)
    receive(driver, { id: 'opencode-auth', result: {} })
    expect(due(driver)).toEqual([expect.objectContaining({ method: 'session/load', params: expect.objectContaining({ sessionId: 'ses_1' }) })])
    receive(driver, { id: 'opencode-session', result: { configOptions: config() } })
    expect(driver.ready()).toBe(true)
    expect(driver.providerSessionId()).toBe('ses_1')
  })

  // Recorded from OpenCode 2.1.1 (fixtures/opencode-recordings.md).
  const replay = (file: string, options: ChatStageOptions) => {
    const records = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8').trim().split('\n').map(parseChatRecord)
    expect(records.flatMap((record, index) => record ? [] : [index])).toEqual([])
    const driver = new OpenCodeAcp('stage', options)
    records.forEach((record) => { if (record) driver.apply(record) })
    for (const item of driver.items.list()) expect(ChatItem.safeParse(item).success).toBe(true)
    expect(driver.due()).toEqual([])
    return driver
  }

  it('replays a real session: Conclave\'s preview, browser and terminal tools by Conclave\'s names, its own ask answered', () => {
    const driver = replay('opencode-session.jsonl', { ...OPTIONS, extraDirs: [] })
    expect(items(driver, 'turn').map((turn) => turn.state)).toEqual(['completed', 'completed', 'completed'])
    // Its answer's tokens, the cache counted as input; the free model costs nothing.
    expect(items(driver, 'turn')[0]).toMatchObject({ usage: { input: 15232 + 27136, output: 475 }, metering: { reportedCostUsd: 0 } })
    const tools = items(driver, 'tool').map((tool) => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['fileChange', 'conclave.show_preview', 'conclave.browser_navigate', 'conclave.browser_screenshot', 'conclave.terminal_run', 'conclave.terminal_read']))
    expect(tools.filter((name) => name === 'execute')).toEqual([])
    expect(items(driver, 'approval').find((approval) => approval.tool === 'conclave_terminal_run' || approval.tool === 'conclave.terminal_run')).toMatchObject({ resolution: 'allowed' })
  })

  it('replays a real resume: the loaded session goes on under its id', () => {
    const driver = replay('opencode-resume.jsonl', { ...OPTIONS, extraDirs: [], resume: 'ses_0001' })
    expect(driver.providerSessionId()).toBe('ses_0001')
    expect(items(driver, 'turn').at(-1)).toMatchObject({ state: 'completed', usage: { input: expect.any(Number), output: expect.any(Number) } })
  })
})
