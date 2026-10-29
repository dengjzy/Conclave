import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DSH_MODES, DSH_RUNTIME_VERSION, isPlanApproval, type ChatItem } from '@conclave/protocol'
import type { ChatRecord, ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { dshDialect } from './dsh-dialect'

const Request = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional() })
const model = JSON.stringify(['test-provider', 'test-model'])
const configs = [
  { id: 'model', category: 'model', name: 'Model', currentValue: model, options: [{ value: model, name: 'Test model' }] },
  { id: 'reasoning_effort', category: 'thought_level', name: 'Reasoning', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { id: 'conclave.permissionMode', category: 'mode', name: 'Mode', currentValue: 'ask', options: DSH_MODES.map((value) => ({ value, name: value })) }
]
const initialized = { protocolVersion: 1, _meta: { conclaveDshRuntime: DSH_RUNTIME_VERSION }, agentCapabilities: { sessionCapabilities: { resume: {}, additionalDirectories: {} } } }
const items = <K extends ChatItem['kind']>(driver: AcpDriver, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)

function start(options: Partial<ChatStageOptions> = {}) {
  const stage = { cwd: '/project', extraDirs: [], resume: null, ...options }
  const driver = new AcpDriver(dshDialect, 'stage', stage)
  const records: ChatRecord[] = []
  const apply = (record: ChatRecord) => { records.push(record); driver.apply(record) }
  const receive = (frame: unknown) => apply({ dir: 'in', at: records.length, frame })
  const due = () => driver.due().map((frame) => { apply({ dir: 'out', at: records.length, frame }); return Request.parse(frame) })
  due()
  receive({ id: 'dsh-init', result: initialized })
  const opening = due()
  receive({ id: 'dsh-session', result: { sessionId: 'session', configOptions: configs } })
  due()
  receive({ id: 'dsh-models', result: { models: [{ value: model, name: 'Test model', configOptions: [configs[1]] }] } })
  due()
  return { driver, records, receive, apply, due, opening, stage }
}

describe('DeepSeek Harness ACP', () => {
  it('negotiates resume and preserves the original id when the response has none', () => {
    const { driver, receive, opening } = start({ resume: 'persisted' })
    expect(opening).toMatchObject([{ method: 'session/resume', params: { sessionId: 'persisted' } }])
    expect(driver.ready()).toBe(true)
    const restoring = new AcpDriver(dshDialect, 'restore', { cwd: '/project', extraDirs: [], resume: 'persisted' })
    for (const frame of restoring.due()) restoring.apply({ dir: 'out', at: 0, frame })
    restoring.apply({ dir: 'in', at: 1, frame: { id: 'dsh-init', result: initialized } })
    for (const frame of restoring.due()) restoring.apply({ dir: 'out', at: 2, frame })
    restoring.apply({ dir: 'in', at: 3, frame: { id: 'dsh-session', result: { configOptions: configs } } })
    expect(restoring.providerSessionId()).toBe('persisted')
    receive({ method: 'session/update', params: { sessionId: 'session', update: { sessionUpdate: 'usage_update', used: 100, size: 32000 } } })
    expect(items(driver, 'state').at(-1)?.models[0]?.id).toBe(model)
  })

  it('refuses an official ACP without the Conclave extension before opening a session', () => {
    const driver = new AcpDriver(dshDialect, 'stage', { cwd: '/project', extraDirs: [], resume: null })
    for (const frame of driver.due()) driver.apply({ dir: 'out', at: 0, frame })
    driver.apply({ dir: 'in', at: 1, frame: { id: 'dsh-init', result: { protocolVersion: 1 } } })
    expect(driver.failure()).toMatch(/运行时版本/)
    expect(driver.due()).toEqual([])
  })

  it('keeps project notes off the logged prompt, and reconstructs a completed turn from its log', () => {
    const { driver, records, stage, receive, apply } = start({ extraDirs: ['/extra'] })
    expect(driver.ready()).toBe(true)
    const message = driver.send('hello')
    expect(JSON.stringify(message.wire)).toContain('/extra')
    expect(JSON.stringify(message.logged)).not.toContain('/extra')
    apply({ dir: 'out', at: 20, frame: message.logged })
    receive({ method: 'session/update', params: { sessionId: 'session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } })
    receive({ id: 'dsh-prompt-1', result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 20 } } })
    expect(items(driver, 'turn').at(-1)).toMatchObject({ state: 'completed', usage: { input: 30, output: 4 } })
    const replay = new AcpDriver(dshDialect, 'stage', stage)
    records.forEach((record) => replay.apply(record))
    expect(replay.items.list()).toEqual(driver.items.list())
  })

  it('uses the shared question and plan cards and switches policy before accepting a plan', () => {
    const { driver, receive, apply } = start()
    apply({ dir: 'out', at: 20, frame: driver.send('plan').logged })
    receive({ id: 'q', method: '_conclave/question', params: { sessionId: 'session', toolCallId: 'q', questions: [{ id: 'choice', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }] } })
    expect(items(driver, 'question')).toHaveLength(1)
    expect(driver.respond('string:q', { decision: 'allow', answers: { choice: ['a'] } })).toMatchObject([{ result: { outcome: { outcome: 'answered' } } }])
    receive({ id: 'plan', method: '_conclave/plan', params: { sessionId: 'session', toolCallId: 'p', plan: '# Plan' } })
    expect(items(driver, 'approval').some(isPlanApproval)).toBe(true)
    const [switchMode] = driver.respond('string:plan', { decision: 'allow' })
    expect(switchMode).toMatchObject({ method: 'session/set_config_option', params: { configId: 'conclave.permissionMode', value: 'acceptEdits' } })
  })

  it('cannot approve a plan in a stage that is only allowed to plan', () => {
    const { driver, receive, apply } = start({ planOnly: true })
    // The initial policy change is acknowledged before the first prompt.
    for (const frame of driver.due()) apply({ dir: 'out', at: 20, frame })
    receive({ id: 'dsh-initial-permissionMode', result: { configOptions: configs.map((entry) => entry.category === 'mode' ? { ...entry, currentValue: 'plan' } : entry) } })
    apply({ dir: 'out', at: 21, frame: driver.send('plan').logged })
    receive({ id: 'plan', method: '_conclave/plan', params: { sessionId: 'session', toolCallId: 'p', plan: '# Plan' } })
    expect(() => driver.respond('string:plan', { decision: 'allow' })).toThrow(/只能规划/)
  })
})
