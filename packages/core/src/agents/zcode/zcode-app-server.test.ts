import { readFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChatItem } from '@conclave/protocol'
import type { ChatRecord, ChatStageOptions } from '../../chat-driver'
import { parseChatRecord } from '../../chat-log'
import { ZCodeAppServer } from './zcode-app-server'

// Recorded from zcode-runtime 0.17.0 (ZCode 3.16.2) on a mock model service: fixtures/zcode-recordings.md.
const MCP = { command: 'node', args: ['/conclave/mcp.mjs'] }
const OPTIONS: ChatStageOptions = { cwd: '/work/repo', extraDirs: [], resume: null, mcp: MCP, allowBypass: true }
const SESSION = 'sess_43e10858-7f17-4180-9666-cbbb489cf482'

const records = (name: string): ChatRecord[] => readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').flatMap((line) => {
  const record = parseChatRecord(line)
  return record ? [record] : []
})
const items = <K extends ChatItem['kind']>(driver: ZCodeAppServer, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)
const state = (driver: ZCodeAppServer) => items(driver, 'state').at(-1)
const shown = (driver: ZCodeAppServer) => driver.items.list().map(({ at: _at, revision: _revision, ...item }) => item)
const Sent = z.looseObject({ id: z.string(), method: z.string(), params: z.looseObject({ type: z.string().optional(), payload: z.looseObject({}).optional() }).optional() })

// The stage as it ran, and as its log rebuilds it.
function play(name: string, options: ChatStageOptions): { live: ZCodeAppServer; replayed: ZCodeAppServer } {
  const live = new ZCodeAppServer('stage', options)
  const replayed = new ZCodeAppServer('stage', options)
  for (const record of records(name)) {
    live.apply(record)
    if (record.dir !== 'in') { replayed.apply(record); continue }
    const kept = live.logged(record.frame)
    if (kept !== null) replayed.apply({ ...record, frame: kept })
  }
  return { live, replayed }
}

const out = (driver: ZCodeAppServer, frame: unknown, at = 1) => driver.apply({ dir: 'out', at, frame })
const receive = (driver: ZCodeAppServer, frame: unknown, at = 2) => driver.apply({ dir: 'in', at, frame })
const topic = (session: string, payload: unknown, from = 0, to = 1) => ({ method: 'v4/conversation/frame', params: { wireVersion: 3, kind: 'complete', topic: `conversation/${session}`, logicalFrameId: `lf-${to}`, frame: { topic: `conversation/${session}`, subscriptionId: 's', fromSeq: from, toSeq: to, payload } } })
const snapshot = (session: string, rows: unknown[] = [], config: object = { provider: 'zai', model: 'glm-5.3', thought: 'enabled', thoughtLevels: ['disabled', 'enabled'], mode: 'build', planEnabled: false }) =>
  topic(session, { kind: 'snapshot', snapshot: { sessionId: session, revision: 3, control: { phase: 'completedSuccess' }, config, usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, rows: { window: rows } } }, 0, 0)
const settings = { model: { available: [{ ref: { providerId: 'zai', modelId: 'glm-5.3' }, label: 'GLM-5.3', providerLabel: 'Z.ai', reasoning: { levels: [{ value: 'disabled' }, { value: 'enabled' }] }, properties: { inputFormat: { supportsImage: false } } }, { ref: { providerId: 'zai', modelId: 'glm-5.3-flash' }, label: 'GLM-5.3-Flash', reasoning: { levels: [] } }], current: { providerId: 'zai', modelId: 'glm-5.3' } } }

// A driver past its handshake on a new session.
function opened(options: ChatStageOptions = OPTIONS, read: object = settings): ZCodeAppServer {
  const driver = new ZCodeAppServer('stage', options)
  const [create] = driver.due()
  out(driver, create)
  receive(driver, { id: 'zcode-create', result: { status: 'accepted', result: { type: 'createSession', sessionId: 'sess_1' } } })
  for (const frame of driver.due()) out(driver, frame)
  receive(driver, { id: 'zcode-subscribe', result: { ack: { subscriptionId: 's', mode: 'snapshot', logEpoch: 'e' } } })
  receive(driver, snapshot('sess_1'))
  receive(driver, { id: 'zcode-read', result: { settings: read, slashCommands: [{ name: 'compact', description: 'Compact the conversation', inputHint: '/compact [instructions]' }] } })
  return driver
}

function sendText(driver: ZCodeAppServer, text: string, ref: string) {
  const { wire, logged } = driver.send(text)
  driver.apply({ dir: 'out', at: 3, frame: logged, ref })
  return Sent.parse(wire)
}

const permission = (requestId: string, toolName: string, input: object) => ({
  id: `server-${requestId}`,
  method: 'interaction/requestPermission',
  params: {
    requestId, sessionId: 'sess_1', toolCallId: `call_${requestId}`, toolName, input, reason: 'Tool has side effects and requires approval', riskLevel: 'medium',
    options: [
      { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once', response: { decision: 'allow', reason: 'Approved once' } },
      { kind: 'allow_always', name: 'Always allow in this project', optionId: 'allow_project', response: { decision: 'allow', permissionUpdates: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName, ruleContent: 'x' }] }], reason: 'Approved for this project' } },
      { kind: 'deny', name: 'Deny', optionId: 'deny', response: { decision: 'deny', reason: 'The user does not want this.' } }
    ]
  }
})

describe('ZCode over its app-server', () => {
  it.each<[string, ChatStageOptions]>([
    ['zcode-session', OPTIONS],
    ['zcode-resume', { ...OPTIONS, resume: SESSION, preferred: { permissionMode: 'ask' } }],
    ['zcode-plan', { ...OPTIONS, preferred: { permissionMode: 'plan' } }],
    ['zcode-readonly', { ...OPTIONS, preferred: { permissionMode: 'readOnly' }, readOnly: true }]
  ])('rebuilds %s from its log as it ran', (name, options) => {
    const { live, replayed } = play(name, options)
    expect(shown(replayed)).toEqual(shown(live))
    expect(live.activity()).toBe('idle')
  })

  it('shows a session turn by turn: approvals, a refusal, Conclave tools, a question, a stop and a steer', () => {
    const { live } = play('zcode-session', OPTIONS)
    expect(live.providerSessionId()).toBe(SESSION)
    const turns = items(live, 'turn')
    expect(turns.map((turn) => [turn.id, turn.state])).toEqual([
      ['turn:r1', 'completed'], ['turn:r2', 'completed'], ['turn:r3', 'completed'], ['turn:r4', 'completed'],
      ['turn:r5', 'completed'], ['turn:r6', 'completed'], ['turn:r7', 'interrupted'], ['turn:r8', 'completed']
    ])
    expect(turns[0]?.usage).toEqual({ input: 120, output: 12 })
    expect(turns[0]?.metering?.models[0]).toMatchObject({ model: 'mock/mock-model', input: 120, output: 12, costUsd: null })
    const tools = items(live, 'tool')
    expect(tools.map((tool) => [tool.name, tool.status])).toEqual([['Write', 'done'], ['Bash', 'denied'], ['mcp__conclave__user_todo_list', 'done'], ['Bash', 'done']])
    expect(tools[0]?.diffs).toEqual([{ path: '/work/repo/hello.txt', change: 'add', patch: '+hello from zcode' }])
    expect(tools[2]?.display).toEqual({ name: 'user_todo_list', server: 'conclave' })
    expect(tools[3]).toMatchObject({ title: 'echo hi-from-bash', output: 'hi-from-bash', execution: { status: 'completed', exitCode: null } })
    // Conclave's read-only tools went through without a card.
    expect(items(live, 'approval').map((approval) => [approval.tool, approval.resolution])).toEqual([['Write', 'allowed'], ['Bash', 'denied']])
    expect(items(live, 'question')[0]).toMatchObject({ resolution: 'answered', answers: { 'Which color?': ['Blue'] } })
    // The message sent into the running turn shows as the user's, before the turn's reply.
    const steered = live.items.list().findIndex((item) => item.id === 'u:r9')
    expect(live.items.get('u:r9')).toMatchObject({ kind: 'user', text: 'also say hi', steer: true })
    expect(steered).toBeLessThan(live.items.list().findIndex((item) => item.id === 'turn:r8'))
    expect(state(live)).toMatchObject({ permissionMode: 'bypass', effort: 'low', model: 'mock/mock-model', context: { used: 132, window: 200000 } })
    // The start note goes to ZCode, not into the chat.
    expect(live.items.get('u:r1')).toMatchObject({ text: 'hello there' })
  })

  it('resumes a session with Conclave MCP server given again and the saved mode switched back', () => {
    const resumed = records('zcode-resume')
    const sent = resumed.flatMap((record) => { const frame = Sent.safeParse(record.dir === 'out' ? record.frame : null); return frame.success ? [frame.data] : [] })
    expect(sent[0]).toMatchObject({ method: 'session/resume', params: { sessionId: SESSION, mcpServers: [{ name: 'conclave', command: 'node', args: ['/conclave/mcp.mjs'], env: [] }] } })
    const { live } = play('zcode-resume', { ...OPTIONS, resume: SESSION, preferred: { permissionMode: 'ask' } })
    // The first stage's rows are not shown again.
    expect(items(live, 'user').map((item) => item.id)).toEqual(['u:r1', 'u:r2'])
    expect(live.items.get('u:r2')).toMatchObject({ text: 'what is in this image' })
    expect(state(live)).toMatchObject({ permissionMode: 'ask' })
  })

  it('carries a plan out in the mode it is approved in', () => {
    const { live } = play('zcode-plan', { ...OPTIONS, preferred: { permissionMode: 'plan' } })
    expect(items(live, 'approval')[0]).toMatchObject({ tool: 'ExitPlanMode', title: '计划', resolution: 'allowedForSession', mode: 'acceptEdits' })
    expect(state(live)).toMatchObject({ permissionMode: 'acceptEdits' })
  })

  it('refuses a file edit in a read-only stage without asking', () => {
    const { live } = play('zcode-readonly', { ...OPTIONS, preferred: { permissionMode: 'readOnly' }, readOnly: true })
    expect(items(live, 'approval')[0]).toMatchObject({ tool: 'Write', resolution: 'denied', detail: '此阶段只读，Conclave 已拒绝这次修改' })
    expect(items(live, 'tool')[0]).toMatchObject({ name: 'Write', status: 'denied' })
    expect(state(live)).toMatchObject({ permissionMode: 'readOnly' })
  })

  it('switches a resumed session to the chosen mode, then model, one revision after the other, before it is ready', () => {
    const driver = new ZCodeAppServer('stage', { ...OPTIONS, resume: 'sess_r', preferred: { permissionMode: 'ask', model: 'zai/glm-5.3-flash' } })
    const [resume] = driver.due()
    out(driver, resume)
    receive(driver, { id: 'zcode-resume', result: {} })
    for (const frame of driver.due()) out(driver, frame)
    receive(driver, snapshot('sess_r', [], { provider: 'zai', model: 'glm-5.3', thought: 'enabled', mode: 'yolo', planEnabled: false }))
    receive(driver, { id: 'zcode-read', result: { settings } })
    const [mode] = driver.due()
    expect(mode).toMatchObject({ id: 'zcode-initial-mode', params: { type: 'switchCollaborationMode', payload: { mode: 'build' }, baseRevision: 3 } })
    out(driver, mode)
    receive(driver, { id: 'zcode-initial-mode', result: { status: 'accepted' } })
    // The model waits for the state the mode switch changed.
    expect(driver.due()).toEqual([])
    expect(driver.ready()).toBe(false)
    receive(driver, topic('sess_r', { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { revision: 4, config: { provider: 'zai', model: 'glm-5.3', thought: 'enabled', mode: 'build', planEnabled: false } } }] }))
    const [model] = driver.due()
    expect(model).toMatchObject({ id: 'zcode-initial-model', params: { type: 'switchModelConfig', payload: { provider: 'zai', model: 'glm-5.3-flash' }, baseRevision: 4 } })
    out(driver, model)
    receive(driver, { id: 'zcode-initial-model', result: { status: 'accepted' } })
    // Accepted is not yet applied: ready once the state shows the model.
    expect(driver.ready()).toBe(false)
    receive(driver, topic('sess_r', { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { revision: 5, config: { provider: 'zai', model: 'glm-5.3-flash', thought: 'enabled', mode: 'build', planEnabled: false } } }] }, 1, 2))
    expect(driver.ready()).toBe(true)
  })

  it('refuses to start a resumed session left freer than the mode chosen', () => {
    const driver = new ZCodeAppServer('stage', { ...OPTIONS, resume: 'sess_r', preferred: { permissionMode: 'ask' } })
    out(driver, driver.due()[0])
    receive(driver, { id: 'zcode-resume', result: {} })
    for (const frame of driver.due()) out(driver, frame)
    receive(driver, snapshot('sess_r', [], { provider: 'zai', model: 'glm-5.3', thought: 'enabled', mode: 'yolo', planEnabled: false }))
    receive(driver, { id: 'zcode-read', result: { settings } })
    out(driver, driver.due()[0])
    receive(driver, { id: 'zcode-initial-mode', result: { status: 'stale', reasonCode: 'proto.staleRevision' } })
    expect(driver.ready()).toBe(false)
    expect(driver.failure()).toMatch(/没能切到所选的权限模式（现在是 bypass）/)
  })

  it('carries the chosen effort into a resumed session, with its model or alone', () => {
    const driver = new ZCodeAppServer('stage', { ...OPTIONS, resume: 'sess_r', preferred: { permissionMode: 'ask', effort: 'disabled' } })
    out(driver, driver.due()[0])
    receive(driver, { id: 'zcode-resume', result: {} })
    for (const frame of driver.due()) out(driver, frame)
    receive(driver, snapshot('sess_r', [], { provider: 'zai', model: 'glm-5.3', thought: 'enabled', mode: 'build', planEnabled: false }))
    receive(driver, { id: 'zcode-read', result: { settings } })
    expect(driver.due()).toEqual([expect.objectContaining({ id: 'zcode-initial-model', params: expect.objectContaining({ payload: { provider: 'zai', model: 'glm-5.3', thought: 'disabled' } }) })])
  })

  it('starts a stage on a model provider on its models alone, and refuses one ZCode left elsewhere', () => {
    const providerModels = [{ id: 'conclave-glm/glm-5.3', label: 'glm-5.3', description: null, efforts: [], isDefault: true, autoMode: true }]
    const onProvider = { ...OPTIONS, providerModels }
    const driver = new ZCodeAppServer('stage', onProvider)
    expect(driver.due()[0]).toMatchObject({ params: { payload: { config: { provider: 'conclave-glm', model: 'glm-5.3' } } } })
    const started = (config: object, options: ChatStageOptions = onProvider) => {
      const stage = new ZCodeAppServer('stage', options)
      out(stage, stage.due()[0])
      receive(stage, { id: 'zcode-create', result: { status: 'accepted', result: { sessionId: 'sess_p' } } })
      for (const frame of stage.due()) out(stage, frame)
      receive(stage, snapshot('sess_p', [], config))
      receive(stage, { id: 'zcode-read', result: { settings: { model: { available: [], current: null } } } })
      return stage
    }
    const good = started({ provider: 'conclave-glm', model: 'glm-5.3', mode: 'build', planEnabled: false })
    expect(good.ready()).toBe(true)
    expect(state(good)?.models.map((model) => model.id)).toEqual(['conclave-glm/glm-5.3'])
    const elsewhere = started({ provider: 'zai', model: 'glm-5.3', mode: 'build', planEnabled: false })
    expect(elsewhere.ready()).toBe(false)
    expect(elsewhere.failure()).toMatch(/没有用上服务商的模型 conclave-glm\/glm-5.3（现在是 zai\/glm-5.3）/)
    const none = started({ mode: 'build', planEnabled: false })
    expect(none.failure()).toMatch(/现在是 无/)
    // Another of the provider's models than the one chosen will not do either.
    const two = { ...onProvider, providerModels: [...providerModels, { ...providerModels[0]!, id: 'conclave-glm/glm-5.3-flash', isDefault: false }], preferred: { model: 'conclave-glm/glm-5.3-flash' } }
    expect(started({ provider: 'conclave-glm', model: 'glm-5.3', mode: 'build', planEnabled: false }, two).failure()).toMatch(/没有用上服务商的模型 conclave-glm\/glm-5.3-flash（现在是 conclave-glm\/glm-5.3）/)
    expect(started({ provider: 'conclave-glm', model: 'glm-5.3-flash', mode: 'build', planEnabled: false }, two).ready()).toBe(true)
  })

  it('makes a session in the chosen mode, with its folders and MCP servers named', () => {
    const driver = new ZCodeAppServer('stage', { ...OPTIONS, extraDirs: ['/work/other'], references: ['/work/ref'], userMcp: [{ name: 'docs', type: 'http', url: 'https://docs.example/mcp' }], preferred: { permissionMode: 'acceptEdits', model: 'zai/glm-5.3', effort: 'enabled' } })
    const [create] = driver.due()
    expect(create).toMatchObject({
      id: 'zcode-create',
      method: 'v4/command',
      params: {
        sessionId: null,
        type: 'createSession',
        payload: {
          workspaceId: '/work/repo',
          additionalDirectories: ['/work/other', '/work/ref'],
          config: { mode: 'edit', planEnabled: false, provider: 'zai', model: 'glm-5.3', thought: 'enabled' },
          mcpServers: [{ name: 'conclave', command: 'node', args: ['/conclave/mcp.mjs'], env: [] }, { name: 'docs', type: 'http', url: 'https://docs.example/mcp', headers: [] }]
        }
      }
    })
    // Asked before the session is made, its runtime preferences carry the same folders.
    out(driver, create)
    receive(driver, { id: 'server-1', method: 'session/requestRuntimePreferences', params: { sessionId: 'sess_1', scope: 'runtime-materialization' } })
    receive(driver, { id: 'server-2', method: 'interaction/requestOfficialMcpAuthHeaders', params: {} })
    expect(driver.due()).toEqual([
      { id: 'server-1', result: { additionalDirectories: ['/work/other', '/work/ref'], nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } },
      { id: 'server-2', error: { code: -32601, message: 'Conclave does not handle interaction/requestOfficialMcpAuthHeaders' } }
    ])
  })

  it('starts a plan-only stage in plan mode and offers nothing else', () => {
    const driver = opened({ ...OPTIONS, planOnly: true })
    expect(Sent.parse(records('zcode-plan').find((record) => record.dir === 'out')?.frame).params?.payload).toMatchObject({ config: { mode: 'build', planEnabled: true } })
    expect(state(driver)?.permissionModes).toEqual(['plan'])
  })

  it('offers its models, efforts and commands, auto among the modes and bypass where allowed', () => {
    const driver = opened()
    expect(driver.ready()).toBe(true)
    expect(state(driver)).toMatchObject({
      permissionMode: 'ask',
      permissionModes: ['ask', 'acceptEdits', 'plan', 'auto', 'readOnly', 'bypass'],
      model: 'zai/glm-5.3',
      effort: 'enabled',
      commands: [{ name: 'compact', description: 'Compact the conversation', argumentHint: '/compact [instructions]' }]
    })
    expect(state(driver)?.models).toEqual([
      { id: 'zai/glm-5.3', label: 'Z.ai · GLM-5.3', description: null, efforts: ['disabled', 'enabled'], isDefault: true, autoMode: true },
      { id: 'zai/glm-5.3-flash', label: 'GLM-5.3-Flash', description: null, efforts: [], isDefault: false, autoMode: true }
    ])
    expect(state(opened({ ...OPTIONS, allowBypass: false }))?.permissionModes).not.toContain('bypass')
  })

  it('switches mode and model with the revision it holds, and waits for the answer', () => {
    const driver = opened()
    const [mode] = driver.setOption('permissionMode', 'auto')
    expect(mode).toMatchObject({ method: 'v4/command', params: { type: 'switchCollaborationMode', payload: { mode: 'guarded' }, baseRevision: 3 } })
    out(driver, mode)
    expect(driver.optionResult(mode)).toEqual({ pending: true, error: null })
    expect(() => driver.setOption('model', 'zai/glm-5.3-flash')).toThrow(/确认/)
    receive(driver, { id: Sent.parse(mode).id, result: { status: 'stale', reasonCode: 'proto.staleRevision' } })
    expect(driver.optionResult(mode)).toEqual({ pending: false, error: 'proto.staleRevision' })
    const [model] = driver.setOption('model', 'zai/glm-5.3-flash')
    expect(model).toMatchObject({ params: { type: 'switchModelConfig', payload: { provider: 'zai', model: 'glm-5.3-flash', thought: 'enabled' } } })
    expect(() => driver.setOption('effort', 'max')).toThrow(/不支持/)
  })

  it('answers an approval with the option ZCode offered, or a refusal in the user words', () => {
    const driver = opened()
    sendText(driver, 'edit it', 'r1')
    receive(driver, permission('p1', 'Edit', { file_path: '/work/repo/a.ts', old_string: 'a', new_string: 'b' }))
    expect(driver.activity()).toBe('awaiting')
    const card = driver.items.get('a:p1')
    expect(card).toMatchObject({ kind: 'approval', tool: 'Edit', title: '/work/repo/a.ts', toolItemId: 'tool:call_p1', decisions: ['allow', 'allowForSession', 'deny'], reason: 'Tool has side effects and requires approval' })
    expect(card?.kind === 'approval' && card.choices?.[1]).toEqual({ id: 'allow_project', label: 'Always allow in this project', decision: 'allowForSession', grants: [{ kind: 'rules', values: ['Edit(x)'], scope: 'agent', behavior: 'allow' }] })
    expect(driver.respond('p1', { decision: 'allowForSession' })).toEqual([{ id: 'server-p1', result: { decision: 'allow', permissionUpdates: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Edit', ruleContent: 'x' }] }], reason: 'Approved for this project' } }])
    expect(driver.respond('p1', { decision: 'deny', message: 'use b.ts' })).toEqual([{ id: 'server-p1', result: { decision: 'deny', reason: 'use b.ts' } }])
    const [answer] = driver.respond('p1', { decision: 'allow' })
    out(driver, answer)
    expect(driver.items.get('a:p1')).toMatchObject({ resolution: 'allowed', chosen: 'allow_once' })
    expect(driver.activity()).toBe('running')
  })

  it('lets Conclave read-only tools through and refuses edits of a reference project', () => {
    const driver = opened({ ...OPTIONS, references: ['/work/ref'] })
    sendText(driver, 'go', 'r1')
    receive(driver, permission('p1', 'mcp__conclave__show_preview', { path: '/work/repo/a.png' }))
    receive(driver, permission('p2', 'Write', { file_path: '/work/ref/a.ts', content: 'x' }))
    receive(driver, permission('p3', 'mcp__conclave__terminal_run', { command: 'ls' }))
    expect(driver.due()).toEqual([
      { id: 'server-p1', result: { decision: 'allow', reason: 'Approved once' } },
      { id: 'server-p2', result: { decision: 'deny', reason: '参考项目只读，Conclave 已拒绝修改 /work/ref/a.ts' } }
    ])
    expect(driver.items.get('a:p2')).toMatchObject({ resolution: 'denied' })
    // A tool that does something still asks.
    expect(driver.items.get('a:p3')).toMatchObject({ resolution: null })
  })

  it('answers a question with the chosen labels, and a stop cancels what waits', () => {
    const driver = opened()
    sendText(driver, 'ask me', 'r1')
    receive(driver, { id: 'server-q', method: 'interaction/requestUserInput', params: { requestId: 'q1', sessionId: 'sess_1', toolName: 'AskUserQuestion', toolCallId: 'call_q', questions: [{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B', description: 'second' }] }] } })
    expect(driver.items.get('q:q1')).toMatchObject({ kind: 'question', questions: [{ id: 'Which?', header: 'Pick', question: 'Which?', multiSelect: true, options: [{ label: 'A', description: null }, { label: 'B', description: 'second' }] }] })
    expect(driver.respond('q1', { decision: 'allow', answers: { 'Which?': ['A', 'B'] } })).toEqual([{ id: 'server-q', result: { action: 'accept', content: { answers: { 'Which?': 'A, B' } } } }])
    const frames = driver.interrupt()
    expect(frames[0]).toEqual({ id: 'server-q', result: { action: 'cancel' } })
    expect(frames[1]).toMatchObject({ method: 'v4/command', params: { type: 'stop', sessionId: 'sess_1' } })
  })

  it('sends a message with images as their files, and refuses them where the model takes none', () => {
    const driver = opened()
    const image = { id: 'i1', width: 1, height: 1, mime: 'image/png' as const, path: '/conclave/attachments/i1.png', read: () => new Uint8Array() }
    expect(() => driver.send('look', [image])).toThrow(/不支持图片/)
    const flash = opened(OPTIONS, { model: { available: [{ ref: { providerId: 'zai', modelId: 'glm-5.3' }, properties: { inputFormat: { supportsImage: true } } }], current: { providerId: 'zai', modelId: 'glm-5.3' } } })
    expect(flash.send('look', [image]).logged).toMatchObject({ method: 'session/send', params: { sessionId: 'sess_1', content: 'look', attachments: [{ kind: 'image', localPath: '/conclave/attachments/i1.png', filename: 'i1.png', mimeType: 'image/png' }] } })
  })

  it('keeps of a frame what the chat needs: not streamed text, telemetry or a session history', () => {
    const driver = opened()
    const deltas = topic('sess_1', { kind: 'deltas', deltas: [{ op: 'row.delta', rowId: 3, path: 'text', append: 'hi' }, { op: 'state.updated', patch: { revision: 4 } }] }, 1, 2)
    expect(driver.logged(deltas)).toMatchObject({ params: { frame: { payload: { deltas: [{ op: 'state.updated' }] } } } })
    expect(driver.logged(topic('sess_1', { kind: 'deltas', deltas: [{ op: 'row.delta', rowId: 3, append: 'hi' }] }, 2, 3))).toBeNull()
    expect(driver.logged({ method: 'v4/telemetry/event', params: {} })).toBeNull()
    expect(driver.logged({ method: 'startup/storageState', params: { phase: 'ready' } })).toBeNull()
    expect(driver.logged({ id: 'zcode-read', result: { messages: [{}], settings: { model: {} }, slashCommands: [] } })).toEqual({ id: 'zcode-read', result: { settings: { model: { available: [] } }, slashCommands: [] } })
  })

  it('puts a frame split into fragments back together, and logs it whole', () => {
    const driver = opened()
    sendText(driver, 'hi', 'r1')
    const frame = { topic: 'conversation/sess_1', subscriptionId: 's', fromSeq: 0, toSeq: 1, payload: { kind: 'deltas', deltas: [{ op: 'row.appended', row: { rowId: 1, kind: 'turnHeader', state: 'running', origin: 'userInput', startedAt: 1 } }, { op: 'row.appended', row: { rowId: 2, kind: 'assistantText', text: '大的回答', state: 'complete' } }] } }
    const bytes = Buffer.from(JSON.stringify(frame))
    const half = Math.floor(bytes.length / 2)
    const fragment = (index: number, data: Buffer) => ({ method: 'v4/conversation/frame', params: { wireVersion: 3, kind: 'fragment', deliveryKind: 'online', topic: 'conversation/sess_1', subscriptionId: 's', logicalFrameId: 'big', logicalFrameOrdinal: 1, fragmentIndex: index, fragmentCount: 2, logicalBytes: bytes.length, checksum: { algorithm: 'crc32', value: crc32(bytes).toString(16).padStart(8, '0') }, dataBase64: data.toString('base64') } })
    receive(driver, fragment(1, bytes.subarray(half)))
    expect(driver.logged(fragment(1, bytes.subarray(half)))).toBeNull()
    expect(driver.items.get('assistant:2')).toBeUndefined()
    receive(driver, fragment(0, bytes.subarray(0, half)))
    expect(driver.items.get('assistant:2')).toMatchObject({ text: '大的回答' })
    expect(driver.logged(fragment(0, bytes.subarray(0, half)))).toMatchObject({ params: { kind: 'complete', frame: { payload: { kind: 'deltas' } } } })
  })

  it('says a resumed session is lost when ZCode no longer has it', () => {
    const driver = new ZCodeAppServer('stage', { ...OPTIONS, resume: 'sess_gone' })
    const [resume] = driver.due()
    out(driver, resume)
    receive(driver, { id: 'zcode-resume', error: { code: -32004, message: 'Session is not active and not persisted: sess_gone (fault.subscribe.sessionNotFound)' } })
    expect(driver.sessionLost()).toBe(true)
    expect(driver.failure()).toMatch(/没能恢复会话/)
  })
})
