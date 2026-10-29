import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isPlanApproval, type ChatItem } from '@conclave/protocol'
import type { ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { AcpConfig } from '../acp/acp-schema'
import { kimiDialect } from './kimi-dialect'

const Frame = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional() })
const Record = z.object({ dir: z.enum(['in', 'out']), at: z.number(), frame: Frame })
const recording = readFileSync(new URL('./fixtures/kimi-session.jsonl', import.meta.url), 'utf8').trim().split('\n').map((line) => Record.parse(JSON.parse(line)))
const resumedRecording = readFileSync(new URL('./fixtures/kimi-resume.jsonl', import.meta.url), 'utf8').trim().split('\n').map((line) => Record.parse(JSON.parse(line)))
const init = recording.find((record) => record.dir === 'in' && record.frame.id === 'kimi-init')!.frame.result
const openedResult = recording.find((record) => record.dir === 'in' && record.frame.id === 'kimi-session')!.frame.result
const CONFIG = z.looseObject({ configOptions: z.array(AcpConfig) }).parse(openedResult).configOptions
const options: ChatStageOptions = { cwd: '/work', extraDirs: [], resume: null }
const receive = (driver: AcpDriver, frame: unknown) => driver.apply({ dir: 'in', at: 10, frame })
const send = (driver: AcpDriver, frame: unknown) => driver.apply({ dir: 'out', at: 5, frame })
const due = (driver: AcpDriver) => { const frames = driver.due(); frames.forEach((frame) => send(driver, frame)); return frames.map((frame) => Frame.parse(frame)) }
const items = <K extends ChatItem['kind']>(driver: AcpDriver, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)
function opened(extra: Partial<ChatStageOptions> = {}) {
  const driver = new AcpDriver(kimiDialect, 'stage', { ...options, ...extra })
  due(driver)
  receive(driver, { id: 'kimi-init', result: init })
  due(driver)
  receive(driver, { id: 'kimi-session', result: openedResult })
  return driver
}
function prompt(driver: AcpDriver) { send(driver, driver.send('hello').logged) }
const approvalOptions = [{ optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' }, { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
function permission(driver: AcpDriver, id: number, toolCall: object, choices = approvalOptions) {
  receive(driver, { jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'provider-session', toolCall, options: choices } })
}

describe('Kimi Code ACP', () => {
  it('opens the official session without launching terminal authentication and maps its four modes', () => {
    const driver = opened()
    expect(driver.ready()).toBe(true)
    expect(items(driver, 'state').at(-1)).toMatchObject({ permissionMode: 'ask', permissionModes: ['ask', 'plan', 'auto', 'bypass'], model: 'smoke', effort: 'on', models: [{ id: 'smoke', efforts: ['off', 'on'] }] })
    expect(driver.setOption('permissionMode', 'auto')).toEqual([{ jsonrpc: '2.0', id: 'kimi-config-3', method: 'session/set_config_option', params: { sessionId: 'provider-session', configId: 'mode', value: 'auto' } }])
    expect(() => driver.setOption('permissionMode', 'acceptEdits')).toThrow()
    expect(opened({ allowBypass: true }).setOption('permissionMode', 'bypass')).toMatchObject([{ params: { value: 'yolo' } }])
  })

  it('replays the official two-turn recording, including a shell approval and restored history, without duplicating messages or inventing token usage', () => {
    const driver = new AcpDriver(kimiDialect, 'stage', options)
    recording.forEach((record) => driver.apply(record))
    const resumed = new AcpDriver(kimiDialect, 'resumed-stage', { ...options, resume: 'provider-session' })
    resumedRecording.forEach((record) => resumed.apply(record))
    expect(driver.failure()).toBeNull()
    expect(resumed.failure()).toBeNull()
    expect(driver.ready()).toBe(true)
    expect(resumed.ready()).toBe(true)
    expect(items(driver, 'user')).toHaveLength(1)
    expect(items(resumed, 'user')).toHaveLength(1)
    expect([...items(driver, 'assistant'), ...items(resumed, 'assistant')].map((item) => item.text)).toEqual(['Kimi ACP smoke OK', 'Kimi resumed OK'])
    expect(items(resumed, 'tool')).toEqual([])
    expect(items(driver, 'tool')).toMatchObject([{ name: 'commandExecution', input: 'printf conclave-kimi-smoke', output: 'conclave-kimi-smoke', status: 'done' }])
    expect(items(driver, 'approval')).toMatchObject([{ resolution: 'allowed' }])
    expect(items(driver, 'turn')).toHaveLength(1)
    expect(items(resumed, 'turn')).toHaveLength(1)
    for (const turn of items(driver, 'turn')) { expect(turn.state).toBe('completed'); expect(turn.usage).toBeUndefined() }
    expect(items(resumed, 'state').at(-1)?.context).toEqual({ used: 105, window: 32768 })
  })

  it('sends MCP servers and additional projects in session/new and restores through session/load', () => {
    const driver = new AcpDriver(kimiDialect, 'stage', { ...options, resume: 'provider-session', extraDirs: ['/other'], mcp: { command: 'node', args: ['mcp.js'], env: { SCOPE: 'chat' } }, userMcp: [{ type: 'http', name: 'docs', url: 'https://example.com/mcp' }] })
    due(driver)
    receive(driver, { id: 'kimi-init', result: init })
    expect(due(driver)).toMatchObject([{ method: 'session/load', params: { sessionId: 'provider-session', cwd: '/work', additionalDirectories: ['/other'], mcpServers: [{ name: 'conclave', command: 'node', env: [{ name: 'SCOPE', value: 'chat' }] }, { type: 'http', name: 'docs' }] } }])
    receive(driver, { id: 'kimi-session', result: { configOptions: CONFIG } })
    expect(driver.ready()).toBe(true)
    expect(driver.send('look').wire).toMatchObject({ params: { prompt: [{ text: expect.stringContaining('/other') }] } })
  })

  it('switches thinking through its config option and drops it for a model without thinking', () => {
    const driver = opened()
    const [change] = driver.setOption('effort', 'off').map((frame) => Frame.parse(frame))
    send(driver, change)
    receive(driver, { id: change!.id, result: { configOptions: CONFIG.map((config) => config.id === 'thinking' ? { ...config, currentValue: 'off' } : config) } })
    expect(items(driver, 'state').at(-1)?.effort).toBe('off')
    const configOptions = CONFIG.filter((config) => config.id !== 'thinking').map((config) => config.id === 'model' ? { ...config, currentValue: 'plain', options: [{ value: 'plain', name: 'Plain' }, { value: 'smoke', name: 'Smoke' }] } : config)
    receive(driver, { method: 'session/update', params: { sessionId: 'provider-session', update: { sessionUpdate: 'config_option_update', configOptions } } })
    const [model] = driver.setOption('model', 'plain').map((frame) => Frame.parse(frame))
    send(driver, model)
    receive(driver, { id: model!.id, result: { configOptions } })
    expect(items(driver, 'state').at(-1)).toMatchObject({ model: 'plain', effort: null })
    expect(() => driver.setOption('effort', 'on')).toThrow()
  })

  it('turns Kimi’s permission-bridged question into a question and sends the selected opaque option back', () => {
    const driver = opened()
    prompt(driver)
    permission(driver, 20, { toolCallId: 'question', title: 'AskUserQuestion', content: [{ type: 'content', content: { type: 'text', text: 'Which database?' } }] }, [{ optionId: 'q0_opt_0', name: 'PostgreSQL', kind: 'allow_once' }, { optionId: 'q0_opt_1', name: 'SQLite', kind: 'allow_once' }, { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' }])
    const question = items(driver, 'question')[0]!
    expect(question.questions).toMatchObject([{ id: 'question', question: 'Which database?', multiSelect: false, options: [{ id: 'q0_opt_0' }, { id: 'q0_opt_1' }] }])
    expect(items(driver, 'approval')).toEqual([])
    expect(() => driver.respond(question.requestId, { decision: 'allow', answers: { question: ['made-up'] } })).toThrow()
    const answer = driver.respond(question.requestId, { decision: 'allow', answers: { question: ['q0_opt_1'] } })
    expect(answer).toEqual([{ jsonrpc: '2.0', id: 20, result: { outcome: { outcome: 'selected', optionId: 'q0_opt_1' } } }])
    answer.forEach((frame) => send(driver, frame))
    expect(items(driver, 'question')[0]).toMatchObject({ resolution: 'answered', answers: { question: ['q0_opt_1'] } })
  })

  it('shows native plan reviews, preserves the plan text and only offers the mode Kimi resumes in', () => {
    const driver = opened()
    prompt(driver)
    permission(driver, 21, { toolCallId: 'plan', title: 'ExitPlanMode', content: [{ type: 'content', content: { type: 'text', text: '# Plan\n\nImplement Kimi.' } }, { type: 'content', content: { type: 'text', text: 'Requesting approval to exit plan mode' } }] }, [{ optionId: 'plan_approve', name: 'Approve', kind: 'allow_once' }, { optionId: 'plan_revise', name: 'Revise', kind: 'reject_once' }])
    const plan = items(driver, 'approval')[0]!
    expect(isPlanApproval(plan)).toBe(true)
    expect(plan).toMatchObject({ detail: '# Plan\n\nImplement Kimi.', runModes: ['ask'] })
    expect(() => driver.respond(plan.requestId, { decision: 'allow', mode: 'bypass' })).toThrow()
    const answer = driver.respond(plan.requestId, { decision: 'allowForSession', mode: 'ask' })
    expect(answer).toMatchObject([{ result: { outcome: { optionId: 'plan_approve' } } }])
    answer.forEach((frame) => send(driver, frame))
    expect(items(driver, 'approval')[0]).toMatchObject({ resolution: 'allowed', mode: 'ask' })
  })

  it('refuses to approve execution in a planning-only stage, and cancels when the plan is saved', () => {
    const driver = opened({ planOnly: true })
    const [mode] = due(driver)
    receive(driver, { id: mode!.id, result: { configOptions: CONFIG.map((config) => config.id === 'mode' ? { ...config, currentValue: 'plan' } : config) } })
    prompt(driver)
    permission(driver, 22, { title: 'ExitPlanMode', content: [{ type: 'content', content: { type: 'text', text: '# Plan' } }] }, [{ optionId: 'plan_approve', name: 'Approve', kind: 'allow_once' }])
    const plan = items(driver, 'approval')[0]!
    expect(() => driver.respond(plan.requestId, { decision: 'allow' })).toThrow(expect.objectContaining({ reason: 'plan-only' }))
    expect(driver.respond(plan.requestId, { decision: 'deny', saved: true })).toContainEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'provider-session' } })
  })

  it('uses the preceding file tool’s path when a permission request omits it, and never writes a reference', () => {
    const driver = opened({ references: ['/refs'] })
    prompt(driver)
    receive(driver, { method: 'session/update', params: { sessionId: 'provider-session', update: { sessionUpdate: 'tool_call', toolCallId: 'write', title: 'Write', kind: 'edit', rawInput: { file_path: '/refs/new.ts', content: 'x' } } } })
    permission(driver, 23, { toolCallId: 'write', title: 'Write', content: [{ type: 'content', content: { type: 'text', text: 'Requesting approval to write a file' } }] })
    expect(due(driver)).toMatchObject([{ id: 23, result: { outcome: { optionId: 'reject' } } }])
    expect(items(driver, 'approval')[0]).toMatchObject({ resolution: 'denied' })
  })

  it('keeps auth failures visible and refuses a missing native session rather than starting a new conversation silently', () => {
    const driver = opened()
    prompt(driver)
    receive(driver, { id: 'kimi-prompt-1', error: { code: -32000, message: 'Authentication required' } })
    expect(items(driver, 'turn')[0]).toMatchObject({ state: 'failed', error: 'Authentication required' })
    const restoring = new AcpDriver(kimiDialect, 'stage', { ...options, resume: 'missing' })
    due(restoring)
    receive(restoring, { id: 'kimi-init', result: init })
    due(restoring)
    receive(restoring, { id: 'kimi-session', error: { code: -32602, message: 'Unknown sessionId: missing' } })
    expect(restoring.ready()).toBe(false)
    expect(restoring.failure()).toContain('Unknown sessionId')
    expect(restoring.sessionLost()).toBe(true)
  })
})
