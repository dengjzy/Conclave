import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCall, AgentProfile, ChatItem, Conversation, Task, remoteOperationSchemas } from '@conclave/protocol'
import { MobileApp } from './MobileApp'
import { MobileRequestError } from './mobile-connection'
import { ChatPicker } from '../components/ChatPicker'
import { MobileAgentOptions } from './MobileAgentOptions'

vi.mock('../components/ChatPicker', () => ({
  ChatPicker: ({ label, value }: { label: string; value?: unknown }) => createElement('span', { 'data-picker': label }, String(value ?? '')),
  ChatModelPicker: () => createElement('span', { 'data-picker': 'model' })
}))

// Follow the existing SSR handler tests, retaining effect cleanup and refs across renders.
const hooks = vi.hoisted(() => {
  const queued: Array<() => void> = []
  const nodes: Array<{ type: unknown; props: Record<string, unknown> }> = []
  return { cursor: 0, dirty: false, values: new Map<number, unknown>(),
    effects: new Map<number, { deps: readonly unknown[] | undefined; cleanup: (() => void) | void }>(), queued, nodes }
})
const rpc = vi.hoisted(() => {
  const preferenceValues = new Map<string, string>()
  const activity = { active: true, listeners: new Set<(active: boolean) => void>() }
  const scanner = { enabled: false, scan: vi.fn<() => Promise<string | null>>() }
  const capabilities: string[] = []
  const methods: string[] = []
  return {
    connected: false, activeHostId: 'host-one', canConnect: true, isPairing: false, invitationName: '扫码电脑', notify: (_message: string) => {},
    hosts: [
      { id: 'host-one', name: '电脑一', deviceName: '手机', lastConnectedAt: null },
      { id: 'host-two', name: '电脑二', deviceName: '手机', lastConnectedAt: null }
    ],
    ready: Promise.resolve(), preferenceValues, activity, scanner, capabilities, methods,
    platform: {
      get scanInvitation() { return scanner.enabled ? scanner.scan : undefined },
      get deviceName() { return scanner.enabled ? 'Android 测试手机' : undefined },
      preferences: {
        read: (key: string) => preferenceValues.get(key) ?? null,
        write(key: string, value: string | null) { if (value === null) preferenceValues.delete(key); else preferenceValues.set(key, value); return true }
      },
      isActive: () => activity.active,
      subscribeActivity(listener: (active: boolean) => void) { activity.listeners.add(listener); return () => { activity.listeners.delete(listener) } }
    },
    call: vi.fn<(method: string, params: unknown, requestId?: string) => Promise<unknown>>(),
    connect: vi.fn(), disconnect: vi.fn(), importInvitation: vi.fn<(link: string) => void>()
  }
})
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState(initial: unknown) {
      const index = hooks.cursor++
      if (!hooks.values.has(index)) hooks.values.set(index, typeof initial === 'function' ? initial() : initial)
      return [hooks.values.get(index), (update: unknown) => {
        const old = hooks.values.get(index)
        const next = typeof update === 'function' ? update(old) : update
        if (!Object.is(next, old)) { hooks.values.set(index, next); hooks.dirty = true }
      }]
    },
    useRef(initial: unknown) {
      const index = hooks.cursor++
      if (!hooks.values.has(index)) hooks.values.set(index, { current: initial })
      return hooks.values.get(index)
    },
    useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]) {
      const index = hooks.cursor++
      const previous = hooks.effects.get(index)
      if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, at) => Object.is(value, previous.deps?.[at]))) return
      hooks.queued.push(() => {
        previous?.cleanup?.()
        hooks.effects.set(index, { deps, cleanup: effect() })
      })
    }
  }
})
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>()
  const capture = (...args: Parameters<typeof runtime.jsx>) => {
    const [type, props] = args
    if (props && typeof props === 'object') hooks.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsx(...args)
  }
  return { ...runtime, jsx: capture, jsxs: capture }
})
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args
    if (props && typeof props === 'object') hooks.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsxDEV(...args)
  } }
})
vi.mock('./mobile-connection', async (importOriginal) => {
  const transport = await importOriginal<typeof import('./mobile-connection')>()
  return { ...transport, MobileConnection: class {
    constructor(changed: (message: string) => void) { rpc.notify = changed }
    get connected() { return rpc.connected }
    get hosts() { return rpc.hosts }
    get activeHostId() { return rpc.activeHostId }
    get hostName() { return rpc.hosts.find((host) => host.id === rpc.activeHostId)?.name ?? '' }
    get invitationName() { return rpc.isPairing ? rpc.invitationName : '' }
    supports(method: string) { return rpc.methods.includes(method) }
    ready = rpc.ready
    platform = rpc.platform
    get canConnect() { return rpc.canConnect }
    get isPairing() { return rpc.isPairing }
    storageNotice = ''
    invitationProblem = ''
    call = rpc.call
    async connect(...args: [deviceName: string, hostName?: string]) {
      rpc.connect(...args)
      if (rpc.isPairing) {
        rpc.activeHostId = 'paired-host'
        rpc.hosts = [...rpc.hosts.filter((host) => host.id !== 'paired-host'), { id: 'paired-host', name: args[1] || rpc.invitationName, deviceName: args[0], lastConnectedAt: null }]
        rpc.isPairing = false
      }
      rpc.connected = true; rpc.notify('已连接')
    }
    importInvitation(link: string) {
      rpc.importInvitation(link)
      rpc.isPairing = true; rpc.canConnect = true; rpc.activeHostId = ''
      this.disconnect('配对链接已导入')
    }
    disconnect(message = '已断开，可重新连接') { rpc.connected = false; rpc.disconnect(); rpc.notify(message) }
    selectHost(id: string) { rpc.activeHostId = id; rpc.isPairing = false; this.disconnect('已切换电脑，请连接') }
    async renameHost(id: string, name: string) { rpc.hosts = rpc.hosts.map((host) => host.id === id ? { ...host, name } : host) }
    forget() { this.disconnect() }
  } }
})

const conversationId = '11111111-1111-4111-8111-111111111111'
const task = (id: string, withChat = false) => Task.parse({
  id, title: `任务 ${id}`, details: '', status: 'running', repos: [], dependsOn: [], agent: 'codex',
  conversationId: withChat ? conversationId : null, createdAt: 1, updatedAt: 1
})
const conversation = Conversation.parse({
  id: conversationId, title: '对话', titleLocked: false, agent: 'codex', workspacePath: '/test',
  projectPaths: [], managedWorkspace: false, sessionId: 'session', createdAt: 1, updatedAt: 1, chat: { turn: 'idle' }
})
let tasks: Task[]
const freeId = '33333333-3333-4333-8333-333333333333'
const otherFreeId = '44444444-4444-4444-8444-444444444444'
const role = AgentProfile.parse({ id: '55555555-5555-4555-8555-555555555555', name: '审查角色', agent: 'claude', capability: 'readOnly', archivedAt: null, createdAt: 1, updatedAt: 1 })
function workspace(projects = ['/test']) {
  rpc.capabilities = ['conversations', 'projects', 'handoff', 'delegation', 'direct-delegation', 'chat-options', 'stages']
  rpc.methods = Object.keys(remoteOperationSchemas)
  const conversations = [
    Conversation.parse({ ...conversation, id: freeId, title: '独立会话 A', taskId: null }),
    Conversation.parse({ ...conversation, id: otherFreeId, title: '独立会话 B', taskId: null })
  ]
  const calls: AgentCall[] = []
  const normal = rpc.call.getMockImplementation()
  rpc.call.mockImplementation(async (method, params, requestId) => {
    const id = params && typeof params === 'object' && 'id' in params ? params.id : null
    if (method === 'catalog') return { projects, agents: [{ id: 'codex', name: 'Codex', permissionModes: ['ask', 'readOnly'] }, { id: 'claude', name: 'Claude Code', permissionModes: ['ask', 'readOnly'] }], capabilities: rpc.capabilities, methods: rpc.methods }
    if (method === 'conversations.page') return { items: conversations.filter((entry) => !entry.parentConversationId && !entry.taskId), total: conversations.length, nextOffset: null }
    if (method === 'projects.list') return projects.map((path) => ({ path, name: path.split('/').at(-1), taskCount: tasks.length, conversationCount: conversations.length }))
    if (method === 'conversations.get') return conversations.find((entry) => entry.id === id) ?? conversation
    if (method === 'conversations.chatCatalog') return null
    if (method === 'conversations.stages') return []
    if (method === 'agentProfiles.available') return [role]
    if (method === 'agentCalls.list') return calls.filter((call) => call.parentId === id)
    if (method === 'conversations.create') {
      const created = Conversation.parse({ ...conversation, id: crypto.randomUUID(), title: '刚创建的会话', projectPaths: [], sessionId: null, chat: null })
      conversations.push(created); return created
    }
    if (method === 'conversations.continue') {
      const found = conversations.find((entry) => entry.id === id)
      if (!found) throw new Error('missing created conversation')
      found.sessionId = 'continued'; found.chat = { turn: 'idle' }; return { ...found }
    }
    if (method === 'conversations.send') return { ok: true }
    if (method === 'conversations.handoff') return { ...conversations.find((entry) => entry.id === id), agent: 'claude' }
    if (method === 'tasks.handoff') return { ...tasks.find((entry) => entry.id === id), agent: 'claude' }
    if (method === 'agentCalls.dispatch') {
      const call = AgentCall.parse({ id: crypto.randomUUID(), parentId: id, conversationId: crypto.randomUUID(), profile: role, instruction: '审查修改', permissionMode: 'readOnly', readOnly: true, state: 'running', result: null, error: null, delivered: false, createdAt: 1, updatedAt: 1 })
      calls.push(call)
      conversations.push(Conversation.parse({ ...conversation, id: call.conversationId, title: '委派子会话', parentConversationId: id, workspaceReadOnly: true }))
      return call
    }
    if (method === 'agentCalls.cancel') return { ...calls[0], state: 'cancelled' }
    return normal?.(method, params, requestId) ?? Promise.reject(new Error(method))
  })
  return { conversations, calls }
}
async function selectConversation(title = '独立会话 A') {
  click('打开工作区'); await settle()
  if (node('button', (props) => label(props.children) === '会话')['aria-current'] !== 'page') { click('会话'); await settle() }
  const props = node('button', (props) => props.className === 'mobile-task-row' && label(props.children).startsWith(title))
  if (typeof props.onClick !== 'function') throw new Error('missing conversation selection')
  props.onClick(); await settle()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function label(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(label).join('')
  if (value && typeof value === 'object' && 'props' in value && value.props && typeof value.props === 'object' && 'children' in value.props) return label(value.props.children)
  return ''
}
function node(type: string, predicate: (props: Record<string, unknown>) => boolean) {
  const match = hooks.nodes.find((entry) => entry.type === type && predicate(entry.props))
  if (!match) throw new Error(`missing ${type}`)
  return match.props
}
function click(text: string) {
  if (text === '切换电脑' && !hooks.nodes.some((entry) => entry.type === 'button' && entry.props['aria-label'] === text)) {
    click(hooks.nodes.some((entry) => entry.type === 'button' && entry.props['aria-label'] === '打开工作区') ? '打开工作区' : '打开任务列表')
    render()
  }
  const props = node('button', (props) => props['aria-label'] === text || label(props.children) === text)
  expect(props.disabled).not.toBe(true)
  if (typeof props.onClick !== 'function') throw new Error('missing click handler')
  props.onClick()
}
function select(id: string) {
  const props = node('button', (props) => props.className === 'mobile-task-row' && label(props.children).startsWith(`任务 ${id}`))
  if (typeof props.onClick !== 'function') throw new Error('missing task selection')
  props.onClick()
}
function selectedTitle() {
  const children = node('button', (props) => props.className === 'mobile-title-chip').children
  if (!Array.isArray(children)) throw new Error('missing task title')
  return label(children[0])
}
function cancelDialog() {
  const props = node('dialog', () => true)
  if (typeof props.onCancel !== 'function') throw new Error('missing dialog cancel handler')
  props.onCancel({ preventDefault() {} })
}
function draft(text: string) {
  const props = node('textarea', (props) => props.id === 'mobile-message')
  if (typeof props.onChange !== 'function') throw new Error('missing draft handler')
  props.onChange({ target: { value: text }, currentTarget: { value: text } })
}
function composerText() { return node('textarea', (props) => props.id === 'mobile-message').value }
function submitComposer() {
  expect(node('button', (props) => props['aria-label'] === '发送').disabled).not.toBe(true)
  const form = node('form', (props) => props.className === 'mobile-composer')
  if (typeof form.onSubmit !== 'function') throw new Error('missing composer submission')
  form.onSubmit({ preventDefault() {} })
}
function picker(name: string, value: string) {
  const props = hooks.nodes.find((entry) => entry.type === ChatPicker && entry.props.label === name)?.props
  if (!props || typeof props.onChange !== 'function') throw new Error(`missing picker ${name}`)
  props.onChange(value)
}
function actionAgent() {
  const props = hooks.nodes.filter((entry) => entry.type === MobileAgentOptions).at(-1)?.props
  if (!props || typeof props.onChange !== 'function') throw new Error('missing action Agent options')
  props.onChange({ agent: 'claude', permissionMode: 'ask' })
}
function actionText(value: string) {
  const props = node('textarea', (props) => props.placeholder === '接下来要继续什么？' || props.placeholder === '说明目标、范围和完成标准')
  if (typeof props.onChange !== 'function') throw new Error('missing action input')
  props.onChange({ target: { value } })
}
function submitAction() {
  const props = node('form', (props) => props.className === 'mobile-sheet-body mobile-action-form')
  if (typeof props.onSubmit !== 'function') throw new Error('missing action form')
  props.onSubmit({ preventDefault() {} })
}
function render() {
  let html = ''
  for (let attempt = 0; attempt < 20; attempt++) {
    hooks.dirty = false; hooks.cursor = 0; hooks.nodes = []
    html = renderToStaticMarkup(createElement(MobileApp))
    for (const effect of hooks.queued.splice(0)) effect()
    if (!hooks.dirty) return html
  }
  throw new Error('render did not settle')
}
async function settle() {
  for (let i = 0; i < 12; i++) { await Promise.resolve(); if (hooks.dirty) render() }
  return render()
}
async function connect() { render(); await settle(); click('重新连接'); await settle() }
function activity(active: boolean) {
  rpc.activity.active = active
  for (const listener of rpc.activity.listeners) listener(active)
}
function chooseHost(name: string) {
  const props = node('button', (props) => props.className === 'mobile-host-row' && label(props.children).startsWith(name))
  expect(props.disabled).not.toBe(true)
  if (typeof props.onClick !== 'function') throw new Error('missing host selector')
  props.onClick()
}
function pairingLink(origin = 'https://computer.example/mobile/') {
  return origin + '#pair=' + encodeURIComponent(JSON.stringify({ version: 2, address: 'tc-test-address', port: 443, ticket: 'A'.repeat(43), expiresAt: Date.now() + 60000, nodeId: '33333333-3333-4333-8333-333333333333', nodeName: '扫码电脑' }))
}
async function openScanner() {
  click('切换电脑'); await settle()
  if (!hooks.nodes.some((entry) => entry.type === 'button' && label(entry.props.children) === '扫码连接')) {
    click('管理电脑与添加连接'); await settle()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('document', { hidden: false, documentElement: { dataset: {} } })
  hooks.values.clear(); hooks.effects.clear(); hooks.queued = []; hooks.nodes = []; hooks.cursor = 0; hooks.dirty = false
  rpc.connected = false; rpc.activeHostId = 'host-one'; rpc.ready = Promise.resolve()
  rpc.capabilities = []
  rpc.methods = ['catalog', 'tasks.page', 'tasks.get', 'tasks.create', 'tasks.start', 'tasks.resumeChat', 'conversations.get', 'chat.page', 'conversations.send', 'conversations.interrupt', 'conversations.respond']
  rpc.canConnect = true; rpc.isPairing = false; rpc.invitationName = '扫码电脑'
  rpc.hosts = [{ id: 'host-one', name: '电脑一', deviceName: '手机', lastConnectedAt: null }, { id: 'host-two', name: '电脑二', deviceName: '手机', lastConnectedAt: null }]
  rpc.disconnect.mockReset(); rpc.connect.mockReset(); rpc.call.mockReset(); rpc.importInvitation.mockReset(); rpc.preferenceValues.clear()
  rpc.scanner.enabled = false; rpc.scanner.scan.mockReset(); rpc.scanner.scan.mockResolvedValue(null)
  rpc.activity.active = true; rpc.activity.listeners.clear()
  tasks = [task('a', true), task('b', true)]
  rpc.call.mockImplementation(async (method, params) => {
    if (method === 'catalog') return { projects: ['/test'], agents: [{ id: 'codex', name: 'Codex' }] }
    if (method === 'tasks.page') return { items: tasks, total: tasks.length, nextOffset: null }
    if (method === 'tasks.get' && params && typeof params === 'object' && 'id' in params) return tasks.find((entry) => entry.id === params.id)
    if (method === 'conversations.get') return conversation
    if (method === 'chat.page') return { items: [], before: null }
    throw new Error(`unhandled ${method}`)
  })
})
afterEach(() => {
  for (const effect of hooks.effects.values()) effect.cleanup?.()
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('MobileApp native pairing', () => {
  it('scans and connects using native and invitation names without asking for name inputs', async () => {
    rpc.scanner.enabled = true; rpc.canConnect = false; rpc.hosts = []; rpc.activeHostId = ''
    const link = pairingLink()
    rpc.scanner.scan.mockResolvedValue(link)
    render(); await settle()
    click('扫码连接'); const html = await settle()
    expect(rpc.importInvitation).toHaveBeenCalledExactlyOnceWith(link)
    expect(rpc.connect).toHaveBeenCalledExactlyOnceWith('Android 测试手机', undefined)
    expect(rpc.connected).toBe(true)
    expect(rpc.hosts[0]?.name).toBe('扫码电脑')
    expect(node('dialog', () => true)['aria-label']).toBe('任务列表')
    expect(html).not.toContain('电脑名称')
    expect(html).not.toContain('设备名称<input')
  })

  it.each([false, true])('keeps the current host and draft when the scanner is cancelled or fails (%s)', async (fails) => {
    rpc.scanner.enabled = true
    await connect(); select('a'); await settle(); draft('keep old connection'); render()
    await openScanner()
    if (fails) rpc.scanner.scan.mockRejectedValue(new Error('相机不可用'))
    else rpc.scanner.scan.mockResolvedValue(null)
    rpc.connect.mockClear(); rpc.disconnect.mockClear()
    click('扫码连接'); const html = await settle()
    expect(rpc.importInvitation).not.toHaveBeenCalled()
    expect(rpc.connect).not.toHaveBeenCalled()
    expect(rpc.disconnect).not.toHaveBeenCalled()
    expect(rpc.connected).toBe(true)
    expect(rpc.activeHostId).toBe('host-one')
    expect(selectedTitle()).toBe('任务 a')
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('keep old connection')
    if (fails) expect(html).toContain('相机不可用')
  })

  it.each(['不是配对二维码', '二维码已过期'])('shows %s without navigating or replacing an existing connection', async (message) => {
    const navigate = vi.fn()
    const location = { get href() { return 'https://localhost/mobile/' }, set href(value: string) { navigate(value) }, assign: navigate, replace: navigate }
    vi.stubGlobal('location', location); vi.stubGlobal('window', { location, open: navigate })
    rpc.scanner.enabled = true
    await connect(); select('a'); await settle(); await openScanner()
    rpc.scanner.scan.mockResolvedValue(message === '不是配对二维码' ? 'https://unrelated.example/' : pairingLink())
    rpc.importInvitation.mockImplementation(() => { throw new Error(message) })
    rpc.connect.mockClear(); rpc.disconnect.mockClear()
    click('扫码连接'); const html = await settle()
    expect(html).toContain(message)
    expect(navigate).not.toHaveBeenCalled()
    expect(rpc.connect).not.toHaveBeenCalled()
    expect(rpc.disconnect).not.toHaveBeenCalled()
    expect(rpc.activeHostId).toBe('host-one')
    expect(rpc.connected).toBe(true)
  })

  it('opens one camera session and connects once for repeated scan clicks', async () => {
    rpc.scanner.enabled = true; rpc.canConnect = false; rpc.hosts = []; rpc.activeHostId = ''
    const scan = deferred<string | null>()
    rpc.scanner.scan.mockReturnValueOnce(scan.promise)
    render(); await settle()
    const scanButton = node('button', (props) => label(props.children) === '扫码连接')
    if (typeof scanButton.onClick !== 'function') throw new Error('missing scan action')
    scanButton.onClick(); scanButton.onClick(); await settle()
    expect(rpc.scanner.scan).toHaveBeenCalledOnce()
    scan.resolve(pairingLink()); await settle()
    expect(rpc.importInvitation).toHaveBeenCalledOnce()
    expect(rpc.connect).toHaveBeenCalledOnce()
    expect(rpc.connected).toBe(true)
  })

  it('does not restore the previous host while the scanner is active', async () => {
    rpc.scanner.enabled = true
    await connect(); select('a'); await settle(); await openScanner()
    const scan = deferred<string | null>()
    rpc.scanner.scan.mockReturnValue(scan.promise)
    click('扫码连接'); await settle()
    rpc.connect.mockClear()
    activity(false); await settle()
    rpc.connected = false; rpc.notify('连接中断'); await settle()
    activity(true); await settle()
    expect(rpc.connect).not.toHaveBeenCalled()
    scan.resolve(null); await settle()
    expect(rpc.importInvitation).not.toHaveBeenCalled()
  })

  it('ignores a camera result delivered after the app has unmounted', async () => {
    rpc.scanner.enabled = true; rpc.canConnect = false; rpc.hosts = []; rpc.activeHostId = ''
    const scan = deferred<string | null>()
    rpc.scanner.scan.mockReturnValue(scan.promise)
    render(); await settle(); click('扫码连接'); await settle()
    for (const effect of hooks.effects.values()) effect.cleanup?.()
    scan.resolve(pairingLink())
    for (let step = 0; step < 12; step++) await Promise.resolve()
    expect(rpc.importInvitation).not.toHaveBeenCalled()
    expect(rpc.connect).not.toHaveBeenCalled()
  })
})

describe('MobileApp asynchronous actions', () => {
  it('migrates a legacy task draft so a successful send cannot restore it again', async () => {
    rpc.preferenceValues.set('conclave-mobile-draft:host-one:a', 'legacy unsent message')
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'conversations.send' ? Promise.resolve({ ok: true }) : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); select('a'); await settle()
    expect(composerText()).toBe('legacy unsent message')
    submitComposer(); await settle()
    click('打开任务列表'); await settle(); select('b'); await settle()
    click('打开任务列表'); await settle(); select('a'); await settle()
    expect(composerText()).toBe('')
    expect(rpc.preferenceValues.has('conclave-mobile-draft:host-one:a')).toBe(false)
  })
  it.each(['async question', 'question', 'approval'] as const)('keeps %s visible and blocks sending only when an explicit response is required', async (kind) => {
    const blocking = kind !== 'async question'
    const request = ChatItem.parse({
      id: 'pending-request', stageId: 'stage', revision: 1, at: 1, requestId: 'request', resolution: null,
      ...(kind === 'approval'
        ? { kind: 'approval', tool: 'Bash', title: '允许操作？', detail: 'pwd', decisions: ['allow', 'deny'] }
        : { kind: 'question', async: !blocking, answers: null, questions: [{ id: 'q', header: '问题', question: '如何继续？', options: [{ label: '继续', description: null }], multiSelect: false }] })
    })
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'chat.page'
      ? Promise.resolve({ items: [request], before: null })
      : method === 'conversations.send' ? Promise.resolve({ ok: true })
      : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); select('a'); await settle()
    draft('用普通消息继续'); const html = render()
    expect(node('div', (props) => props['aria-label'] === '待处理请求')).toBeDefined()
    expect(html).toContain(kind === 'approval' ? '允许操作？' : '如何继续？')
    expect(html.includes('请先处理上方请求')).toBe(blocking)
    expect(node('button', (props) => props['aria-label'] === '发送').disabled).toBe(blocking)
    if (!blocking) {
      const composer = node('form', (props) => props.className === 'mobile-composer')
      if (typeof composer.onSubmit !== 'function') throw new Error('missing composer submission')
      composer.onSubmit({ preventDefault() {} }); await settle()
      expect(rpc.call).toHaveBeenCalledWith('conversations.send', expect.objectContaining({ text: '用普通消息继续' }), expect.any(String))
    } else expect(rpc.call.mock.calls.filter(([method]) => method === 'conversations.send')).toHaveLength(0)
  })

  it('preserves a new draft entered while the previous message is sending', async () => {
    const response = deferred<unknown>()
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'conversations.send' ? response.promise : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); select('a'); await settle()
    draft('first message'); render()
    const composer = node('form', (props) => props.className === 'mobile-composer')
    if (typeof composer.onSubmit !== 'function') throw new Error('missing composer submission')
    composer.onSubmit({ preventDefault() {} })
    await settle()
    expect(rpc.call).toHaveBeenCalledWith('conversations.send', expect.objectContaining({ text: 'first message' }), expect.any(String))
    draft('next message'); render()
    response.resolve({ ok: true }); await settle()
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('next message')
  })

  it('clears an acknowledged draft after reselecting the same task while sending', async () => {
    const response = deferred<unknown>()
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'conversations.send' ? response.promise : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); select('a'); await settle()
    draft('send once'); render()
    const composer = node('form', (props) => props.className === 'mobile-composer')
    if (typeof composer.onSubmit !== 'function') throw new Error('missing composer submission')
    composer.onSubmit({ preventDefault() {} }); await settle()
    click('打开任务列表'); await settle(); select('a'); await settle()
    response.resolve({ ok: true }); await settle()
    expect(selectedTitle()).toBe('任务 a')
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('')
    expect(rpc.preferenceValues.has('conclave-mobile-draft:host-one:a')).toBe(false)
    expect(rpc.call.mock.calls.filter(([method]) => method === 'conversations.send')).toHaveLength(1)
  })

  it.each(['', 'new unsent draft'])('clears only the acknowledged persisted draft after navigating away (%s)', async (replacement) => {
    const response = deferred<unknown>()
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'conversations.send' ? response.promise : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); select('a'); await settle()
    draft('sent from task a'); render()
    const composer = node('form', (props) => props.className === 'mobile-composer')
    if (typeof composer.onSubmit !== 'function') throw new Error('missing composer submission')
    composer.onSubmit({ preventDefault() {} }); await settle()
    expect(rpc.call).toHaveBeenCalledWith('conversations.send', expect.objectContaining({ text: 'sent from task a' }), expect.any(String))
    click('打开任务列表'); await settle(); select('b'); await settle()
    draft('task b stays untouched'); render()
    if (replacement) {
      click('打开任务列表'); await settle(); select('a'); await settle()
      draft(replacement); render()
      click('打开任务列表'); await settle(); select('b'); await settle()
    }
    response.resolve({ ok: true }); await settle()
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('task b stays untouched')
    click('打开任务列表'); await settle(); select('a'); await settle()
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe(replacement)
  })

  it.each([false, true])('keeps the new task selected when a delayed %s launch response arrives', async (resume) => {
    tasks = [task('a', resume), task('b', true)]
    const response = deferred<unknown>()
    const reread = deferred<unknown>()
    let secondTaskReads = 0
    const normal = rpc.call.getMockImplementation()
    const method = resume ? 'tasks.resumeChat' : 'tasks.start'
    rpc.call.mockImplementation((name, params, requestId) => {
      if (name === method) return response.promise
      // A later poll must not hide an old response overwriting the selected task.
      if (name === 'tasks.get' && params && typeof params === 'object' && 'id' in params && params.id === 'b' && ++secondTaskReads > 1) return reread.promise
      return normal?.(name, params, requestId) ?? Promise.reject(new Error(name))
    })
    await connect(); select('a'); await settle()
    if (resume) { click('任务信息'); await settle() }
    click(resume ? '继续任务' : '启动任务'); await settle()
    expect(rpc.call).toHaveBeenCalledWith(method, { id: 'a' }, expect.any(String))
    if (resume) { click('关闭'); await settle() }
    click('打开任务列表'); await settle(); select('b'); await settle()
    expect(selectedTitle()).toBe('任务 b')
    response.resolve(task('a', true)); await settle()
    expect(selectedTitle()).toBe('任务 b')
  })

  it('disconnects after catalog failure and enables another connection attempt', async () => {
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'catalog' ? Promise.reject(new Error('catalog unavailable')) : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect()
    expect(rpc.disconnect).toHaveBeenCalled()
    expect(rpc.connected).toBe(false)
    expect(node('button', (props) => label(props.children) === '重新连接').disabled).toBe(false)
    if (!normal) throw new Error('missing default RPC implementation')
    rpc.call.mockImplementation(normal)
    click('重新连接'); await settle()
    expect(rpc.connected).toBe(true)
    expect(node('dialog', () => true)['aria-label']).toBe('任务列表')
    expect(node('button', (props) => props.className === 'mobile-task-row' && label(props.children) === '任务 a')).toBeDefined()
  })

  it.each([false, true])('retains the write request ID only when the outcome is unknown (%s)', async (unknown) => {
    const normal = rpc.call.getMockImplementation()
    const failure = new MobileRequestError('operation rejected', unknown ? 'operation-timeout' : 'agent-capacity', unknown)
    rpc.call.mockImplementation((method, params, requestId) => method === 'tasks.resumeChat' ? Promise.reject(failure) : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); select('a'); await settle()
    click('任务信息'); await settle()
    click('继续任务'); await settle()
    click('继续任务'); await settle()
    const attempts = rpc.call.mock.calls.filter(([method]) => method === 'tasks.resumeChat')
    expect(attempts).toHaveLength(2)
    expect(typeof attempts[0]?.[2]).toBe('string')
    expect(attempts[0]?.[2] === attempts[1]?.[2]).toBe(unknown)
  })

  it('keeps drafts separate for the same task ID on different computers and restores each', async () => {
    await connect(); select('a'); await settle()
    draft('first computer draft'); render()
    click('切换电脑'); await settle()
    chooseHost('电脑二'); await settle(); await connect(); select('a'); await settle()
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('')
    draft('second computer draft'); render()
    click('切换电脑'); await settle()
    chooseHost('电脑一'); await settle(); await connect(); select('a'); await settle()
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('first computer draft')
    click('切换电脑'); await settle()
    chooseHost('电脑二'); await settle(); await connect(); select('a'); await settle()
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('second computer draft')
  })

  it('pauses reads in the background and immediately refreshes in the foreground', async () => {
    await connect()
    rpc.call.mockClear()
    activity(false); await settle()
    await vi.advanceTimersByTimeAsync(20000); await settle()
    expect(rpc.call).not.toHaveBeenCalled()
    activity(true); await settle()
    expect(rpc.call).toHaveBeenCalledExactlyOnceWith('tasks.page', { offset: 0, filter: 'all', query: '' })
  })

  it('does not reconnect on foreground after a manual disconnect', async () => {
    await connect(); cancelDialog(); await settle(); click('切换电脑'); await settle(); click('断开'); await settle()
    expect(rpc.connected).toBe(false)
    rpc.connect.mockClear(); rpc.call.mockClear()
    activity(false); await settle(); activity(true); await settle()
    expect(rpc.connect).not.toHaveBeenCalled()
    expect(rpc.call).not.toHaveBeenCalled()
    expect(node('button', (props) => label(props.children) === '重新连接').disabled).toBe(false)
  })

  it('recovers when a stale socket fails after foreground, but stops after a manual disconnect', async () => {
    await connect()
    rpc.connect.mockClear()
    activity(false); await settle(); activity(true); await settle()
    expect(rpc.connect).not.toHaveBeenCalled()
    rpc.connected = false; rpc.notify('心跳发现连接中断'); await settle()
    expect(rpc.connect).toHaveBeenCalledOnce()
    expect(rpc.connected).toBe(true)
    cancelDialog(); await settle(); click('切换电脑'); await settle(); click('断开'); await settle()
    activity(false); await settle(); activity(true); await settle()
    rpc.notify('连接已关闭'); await settle()
    expect(rpc.connect).toHaveBeenCalledOnce()
    expect(rpc.connected).toBe(false)
  })

  it('restores a foreground connection without replaying a write whose result is unknown', async () => {
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'conversations.send'
      ? Promise.reject(new MobileRequestError('操作结果未知', 'operation-timeout', true))
      : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); select('a'); await settle(); draft('do not replay'); render()
    const composer = node('form', (props) => props.className === 'mobile-composer')
    if (typeof composer.onSubmit !== 'function') throw new Error('missing composer submission')
    composer.onSubmit({ preventDefault() {} }); await settle()
    expect(rpc.call.mock.calls.filter(([method]) => method === 'conversations.send')).toHaveLength(1)
    rpc.connect.mockClear()
    activity(false); await settle(); rpc.connected = false; rpc.notify('后台连接中断'); await settle()
    activity(true); await settle()
    expect(rpc.connect).toHaveBeenCalledOnce()
    expect(rpc.call.mock.calls.filter(([method]) => method === 'conversations.send')).toHaveLength(1)
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('do not replay')
  })

  it('passes search and filter to task pages and resets the page when either changes', async () => {
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'tasks.page'
      ? Promise.resolve({ items: tasks, total: 42, nextOffset: 20 })
      : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); click('下一页'); await settle()
    expect(rpc.call).toHaveBeenLastCalledWith('tasks.page', { offset: 20, filter: 'all', query: '' })
    const search = node('input', (props) => props.type === 'search')
    if (typeof search.onChange !== 'function') throw new Error('missing search handler')
    search.onChange({ target: { value: 'Mobile' } }); await settle()
    expect(rpc.call).toHaveBeenLastCalledWith('tasks.page', { offset: 0, filter: 'all', query: 'Mobile' })
    click('下一页'); await settle(); click('需要回复'); await settle()
    expect(rpc.call).toHaveBeenLastCalledWith('tasks.page', { offset: 0, filter: 'attention', query: 'Mobile' })
    click('执行中'); await settle()
    expect(rpc.call).toHaveBeenLastCalledWith('tasks.page', { offset: 0, filter: 'running', query: 'Mobile' })
  })

  it('ignores a task creation result after changing computers', async () => {
    const response = deferred<unknown>()
    const fields = new Map([['title', 'Created on first computer'], ['details', ''], ['agent', 'codex'], ['project', '/test']])
    vi.stubGlobal('FormData', class { get(key: string) { return fields.get(key) ?? null } })
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'tasks.create' ? response.promise : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); click('新建任务'); await settle()
    const create = node('form', (props) => typeof props.className === 'string' && props.className.split(' ').includes('mobile-create'))
    if (typeof create.onSubmit !== 'function') throw new Error('missing task creation')
    create.onSubmit({ preventDefault() {}, currentTarget: {} }); await settle()
    expect(rpc.call).toHaveBeenCalledWith('tasks.create', expect.objectContaining({ title: 'Created on first computer' }), expect.any(String))
    click('关闭'); await settle(); click('切换电脑'); await settle(); chooseHost('电脑二'); await settle(); await connect()
    response.resolve(task('created', true)); await settle()
    expect(rpc.activeHostId).toBe('host-two')
    expect(node('dialog', () => true)['aria-label']).toBe('任务列表')
    expect(selectedTitle()).toBe('agents-go')
    expect(rpc.call.mock.calls.filter(([method, params]) => method === 'tasks.get' && params && typeof params === 'object' && 'id' in params && params.id === 'created')).toHaveLength(0)
  })

  it('keeps the selected chat and draft while refreshing both it and the open task drawer', async () => {
    await connect(); select('a'); await settle()
    draft('keep this draft'); render()
    rpc.call.mockClear()
    click('打开任务列表'); await settle()
    expect(node('dialog', () => true)['aria-label']).toBe('任务列表')
    expect(selectedTitle()).toBe('任务 a')
    expect(node('button', (props) => props.className === 'mobile-task-row' && label(props.children) === '任务 a')['aria-current']).toBe('page')
    expect(rpc.call).toHaveBeenCalledWith('tasks.page', { offset: 0, filter: 'all', query: '' })
    expect(rpc.call).toHaveBeenCalledWith('tasks.get', { id: 'a' })
    expect(rpc.call).toHaveBeenCalledWith('chat.page', { id: conversationId })
    cancelDialog(); await settle()
    expect(selectedTitle()).toBe('任务 a')
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('keep this draft')
  })

  it('preserves the selected task when dismissing sheets or returning from settings', async () => {
    await connect(); select('a'); await settle()
    draft('saved while navigating'); render()
    click('新建任务'); await settle()
    expect(node('dialog', () => true)['aria-label']).toBe('新建任务')
    expect(selectedTitle()).toBe('任务 a')
    click('关闭'); await settle()
    click('切换电脑'); await settle()
    expect(node('dialog', () => true)['aria-label']).toBe('电脑')
    click('关闭'); await settle()
    click('打开任务列表'); await settle(); click('设置'); await settle()
    expect(node('h1', () => true).children).toBe('设置')
    click('返回聊天'); await settle()
    expect(selectedTitle()).toBe('任务 a')
    expect(node('textarea', (props) => props.placeholder === '继续这个任务…').value).toBe('saved while navigating')
    expect(rpc.call.mock.calls.filter(([method]) => method === 'tasks.create')).toHaveLength(0)
  })
})

describe('MobileApp workspace', () => {
  it('keeps an older host in task mode without calling new methods', async () => {
    await connect()
    expect(hooks.nodes.some((entry) => entry.type === 'button' && entry.props['aria-label'] === '打开任务列表')).toBe(true)
    expect(hooks.nodes.some((entry) => entry.type === 'button' && label(entry.props.children) === '会话')).toBe(false)
    expect(rpc.call.mock.calls.every(([method]) => rpc.methods.includes(method))).toBe(true)
    expect(rpc.call).toHaveBeenCalledWith('tasks.page', expect.any(Object))
  })

  it('does not probe conversation methods merely because a capability label was advertised', async () => {
    workspace()
    rpc.methods = ['catalog', 'tasks.page', 'tasks.get', 'conversations.get', 'chat.page']
    await connect()
    expect(rpc.call.mock.calls.some(([method]) => method === 'conversations.page' || method === 'conversations.chatCatalog')).toBe(false)
    expect(hooks.nodes.some((entry) => entry.type === 'button' && entry.props['aria-label'] === '打开任务列表')).toBe(true)
  })

  it('starts a first conversation without a project only when its first message is sent', async () => {
    workspace([])
    await connect()
    expect(rpc.call.mock.calls.some(([method]) => method === 'conversations.create')).toBe(false)
    draft('a standalone question'); render(); submitComposer(); await settle()
    expect(rpc.call).toHaveBeenCalledWith('conversations.create', expect.objectContaining({ agent: 'codex', projectPaths: [] }), expect.any(String))
    expect(rpc.call.mock.calls.filter(([method]) => ['conversations.create', 'conversations.continue', 'conversations.send'].includes(method)).map(([method]) => method)).toEqual(['conversations.create', 'conversations.continue', 'conversations.send'])
    expect(selectedTitle()).toBe('刚创建的会话')
    expect(composerText()).toBe('')
  })

  it.each(['conversations.continue', 'conversations.send'])('reuses the created conversation after %s fails', async (failedMethod) => {
    const { conversations } = workspace([])
    const normal = rpc.call.getMockImplementation()
    let failed = false
    rpc.call.mockImplementation((method, params, requestId) => {
      if (method === failedMethod && !failed) { failed = true; return Promise.reject(new MobileRequestError('暂时不可用', 'unavailable', false)) }
      return normal?.(method, params, requestId) ?? Promise.reject(new Error(method))
    })
    await connect(); draft('preserve first message'); render(); submitComposer(); await settle()
    const created = conversations.at(-1)
    expect(selectedTitle()).toBe('刚创建的会话')
    expect(composerText()).toBe('preserve first message')
    submitComposer(); await settle()
    expect(rpc.call.mock.calls.filter(([method]) => method === 'conversations.create')).toHaveLength(1)
    expect(rpc.call.mock.calls.filter(([method]) => method === 'conversations.send').every(([, params]) => params && typeof params === 'object' && 'id' in params && params.id === created?.id)).toBe(true)
    expect(composerText()).toBe('')
  })

  it('migrates a newer draft typed while the first conversation is being created', async () => {
    workspace([])
    const created = deferred<void>()
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === 'conversations.create'
      ? created.promise.then(() => normal?.(method, params, requestId))
      : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); draft('submit this first'); render(); submitComposer(); await settle()
    draft('a newer unsent thought'); render()
    created.resolve(); await settle()
    expect(rpc.call).toHaveBeenCalledWith('conversations.send', expect.objectContaining({ text: 'submit this first' }), expect.any(String))
    expect(composerText()).toBe('a newer unsent thought')
    const title = selectedTitle()
    click('新建会话'); await settle(); await selectConversation(title)
    expect(composerText()).toBe('a newer unsent thought')
  })

  it.each(['conversations.create', 'conversations.continue'])('does not continue a delayed %s chain on a newly selected host', async (delayedMethod) => {
    workspace([])
    const response = deferred<unknown>()
    const normal = rpc.call.getMockImplementation()
    rpc.call.mockImplementation((method, params, requestId) => method === delayedMethod ? response.promise : normal?.(method, params, requestId) ?? Promise.reject(new Error(method)))
    await connect(); draft('first host message'); render(); submitComposer(); await settle()
    expect(rpc.call.mock.calls.some(([method]) => method === delayedMethod)).toBe(true)
    click('切换电脑'); await settle(); chooseHost('电脑二'); await settle(); click('重新连接'); await settle()
    draft('second host draft'); render()
    response.resolve(Conversation.parse({ ...conversation, id: '66666666-6666-4666-8666-666666666666', title: 'late old host', chat: delayedMethod === 'conversations.create' ? null : { turn: 'idle' } })); await settle()
    expect(rpc.activeHostId).toBe('host-two')
    expect(selectedTitle()).not.toBe('late old host')
    expect(composerText()).toBe('second host draft')
    expect(rpc.call.mock.calls.filter(([method]) => method === 'conversations.send')).toHaveLength(0)
  })

  it('separates task, conversation and new-conversation drafts even when IDs coincide', async () => {
    workspace()
    tasks = [task(freeId, true)]
    await connect(); draft('new conversation draft'); render()
    await selectConversation(); draft('existing conversation draft'); render()
    click('打开工作区'); await settle(); click('任务'); await settle(); select(freeId); await settle()
    expect(composerText()).toBe('')
    draft('task draft'); render()
    await selectConversation()
    expect(composerText()).toBe('existing conversation draft')
    click('新建会话'); await settle()
    expect(composerText()).toBe('new conversation draft')
    click('打开工作区'); await settle(); click('任务'); await settle(); select(freeId); await settle()
    expect(composerText()).toBe('task draft')
  })

  it('allows messages in a standalone read-only workspace', async () => {
    const { conversations } = workspace()
    conversations[0] = Conversation.parse({ ...conversations[0], workspaceReadOnly: true })
    await connect(); await selectConversation()
    draft('analyze without editing'); render(); submitComposer(); await settle()
    expect(rpc.call).toHaveBeenCalledWith('conversations.send', expect.objectContaining({ id: freeId, text: 'analyze without editing' }), expect.any(String))
  })

  it.each(['task', 'conversation'])('hands off a %s through its own method and preserves its identity', async (kind) => {
    workspace()
    tasks = tasks.map((entry) => Task.parse({ ...entry, repos: [{ path: '/test', worktreePath: null, branch: null }] }))
    await connect()
    if (kind === 'task') { click('打开工作区'); await settle(); click('任务'); await settle(); select('a'); await settle() }
    else await selectConversation()
    click(kind === 'task' ? '任务信息' : '会话信息'); await settle(); click('移交'); await settle()
    actionAgent(); actionText('继续审查当前修改'); render(); submitAction(); await settle()
    const method = kind === 'task' ? 'tasks.handoff' : 'conversations.handoff'
    expect(rpc.call).toHaveBeenCalledWith(method, expect.objectContaining({ id: kind === 'task' ? 'a' : freeId, agent: 'claude', note: '继续审查当前修改', ...(kind === 'conversation' ? { stopRunning: false } : {}) }), expect.any(String))
    expect(rpc.call.mock.calls.filter(([name]) => name === (kind === 'task' ? 'conversations.handoff' : 'tasks.handoff'))).toHaveLength(0)
    expect(selectedTitle()).toBe(kind === 'task' ? '任务 a' : '独立会话 A')
  })

  it.each(['profile', 'direct'])('delegates with one %s target and defaults temporary work to read-only', async (kind) => {
    workspace()
    await connect(); await selectConversation(); click('会话信息'); await settle(); click('委派'); await settle()
    if (kind === 'profile') { picker('委派角色', role.id); render() }
    actionText('审查修改'); render(); submitAction(); await settle()
    const dispatched = rpc.call.mock.calls.find(([method]) => method === 'agentCalls.dispatch')
    expect(dispatched).toBeDefined()
    expect(dispatched?.[1]).toMatchObject({ id: freeId, instruction: '审查修改', ref: expect.any(String), ...(kind === 'profile' ? { profileId: role.id } : { target: { agent: 'codex', capability: 'readOnly' } }) })
    expect(dispatched?.[1]).not.toHaveProperty(kind === 'profile' ? 'target' : 'profileId')
    expect(selectedTitle()).toBe('独立会话 A')
  })

  it('preserves planning permissions when handing off a pending task', async () => {
    workspace()
    tasks[0] = Task.parse({ ...tasks[0], status: 'pending', repos: [{ path: '/test', worktreePath: null, branch: null }] })
    await connect(); click('打开工作区'); await settle(); click('任务'); await settle(); select('a'); await settle()
    click('任务信息'); await settle(); click('移交'); await settle()
    actionAgent(); actionText('继续规划'); render(); submitAction(); await settle()
    const handed = rpc.call.mock.calls.find(([method]) => method === 'tasks.handoff')
    expect(handed?.[1]).toMatchObject({ id: 'a', agent: 'claude', note: '继续规划' })
    expect(JSON.parse(JSON.stringify(handed?.[1]))).not.toHaveProperty('permissionMode')
  })

  it('keeps an uncertain delegation idempotent across foreground recovery and a deliberate retry', async () => {
    workspace()
    const normal = rpc.call.getMockImplementation()
    let failed = false
    rpc.call.mockImplementation((method, params, requestId) => {
      if (method === 'agentCalls.dispatch' && !failed) { failed = true; return Promise.reject(new MobileRequestError('操作结果未知', null, true)) }
      return normal?.(method, params, requestId) ?? Promise.reject(new Error(method))
    })
    await connect(); await selectConversation(); click('会话信息'); await settle(); click('委派'); await settle()
    actionText('审查修改'); render(); submitAction(); await settle()
    activity(false); activity(true); await settle()
    expect(rpc.call.mock.calls.filter(([method]) => method === 'agentCalls.dispatch')).toHaveLength(1)
    submitAction(); await settle()
    const dispatches = rpc.call.mock.calls.filter(([method]) => method === 'agentCalls.dispatch')
    expect(dispatches).toHaveLength(2)
    expect(dispatches[1]?.[1]).toEqual(dispatches[0]?.[1])
    expect(dispatches[1]?.[2]).toBe(dispatches[0]?.[2])
  })

  it('passes the selected project to both conversation and task pages', async () => {
    workspace(['/test', '/another'])
    await connect(); click('打开工作区'); await settle()
    picker('项目范围', '/another'); render(); await settle()
    expect(rpc.call).toHaveBeenCalledWith('conversations.page', expect.objectContaining({ project: '/another' }))
    click('任务'); await settle()
    expect(rpc.call).toHaveBeenCalledWith('tasks.page', expect.objectContaining({ project: '/another' }))
  })
})
