import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { AgentCall, AgentProfile, createRpcClient, Task, type Conversation, type RpcConnection } from '@conclave/protocol'
import { isAgentCallResult, showAgentCalls, useAgentCalls } from '../agent-calls'
import { useCore } from '../core-store'
import { useChat } from '../chat-state'
import { AgentDelegation, AgentDelegationResult, DelegationDialog } from './AgentDelegation'
import { AgentCalls } from './AgentCalls'
import { ChatSurfaceContext, conversationSurface } from './chat-surface'
import { ConversationInspector } from './ConversationInspector'
import { TaskInspector } from './TaskInspector'
import { TaskToolbar } from './TaskActions'
import { ChatDelegationCard } from './ChatDelegationCard'
import { ConversationView } from './ConversationView'
import { ConversationSplit } from './ConversationSplit'
import { TaskChat } from './TaskChat'

vi.mock('../agent-calls', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agent-calls')>(),
  useAgentCalls: vi.fn(() => ({ calls: null, error: null, dispatched: new Map() }))
}))

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
const parent: Conversation = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Main', titleLocked: false, agent: 'claude',
  workspacePath: '/w', projectPaths: [], managedWorkspace: true, sessionId: null, createdAt: 0, updatedAt: 0
}
const task = Task.parse({ id: 'task', title: 'Task', details: '', repos: [], dependsOn: [], conversationId: parent.id, status: 'running', agent: 'claude', createdAt: 0, updatedAt: 0 })
function connect(features = ['agent-profiles']) {
  const client = createRpcClient(() => {})
  const rpc: RpcConnection = { ...client, features, close() {}, closed: new Promise(() => {}) }
  useCore.setState({ rpc, conversations: { [parent.id]: parent }, tasks: { [task.id]: task } })
}
const renderButton = (conversation = parent) => renderToStaticMarkup(createElement(ChatSurfaceContext.Provider, { value: conversationSurface(conversation) }, createElement(AgentDelegation, { conversation })))
const call = AgentCall.parse({ result: null, error: null, delivered: false, id: '33333333-3333-4333-8333-333333333333', parentId: parent.id, conversationId: '44444444-4444-4444-8444-444444444444', profile: { id: '55555555-5555-4555-8555-555555555555', name: '审查员', agent: 'codex', archivedAt: null, createdAt: 0, updatedAt: 0 }, instruction: '检查变更', state: 'queued', readOnly: true, permissionMode: 'readOnly', createdAt: 10, updatedAt: 20 })
const renderCard = (patch: Partial<AgentCall>) => renderToStaticMarkup(createElement(ChatSurfaceContext.Provider, { value: conversationSurface(parent) }, createElement(ChatDelegationCard, { call: { ...call, ...patch } })))

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  useChat.setState({}, true)
  connect()
  vi.mocked(useAgentCalls).mockReturnValue({ calls: null, error: null, dispatched: new Map() })
})

describe('delegation surfaces', () => {
  it('animates active work, while queued, awaiting, failed and finished cards remain still', () => {
    for (const state of ['starting', 'running'] as const) expect(renderCard({ state })).toContain('data-active="true"')
    for (const state of ['queued', 'awaiting', 'failed', 'completed', 'cancelled'] as const) expect(renderCard({ state })).not.toContain('data-active=')
    const awaiting = renderCard({ state: 'awaiting' })
    expect(awaiting).toContain('等你回答')
    expect(awaiting).toContain('去处理')
    expect(awaiting).toContain('取消委派')
  })

  it('keeps the goal and final outcome readable, with details and conversation links', () => {
    const html = renderCard({ state: 'completed', result: 'Everything passed', delivered: true })
    for (const text of ['审查员', '检查变更', 'Everything passed', '结果返回', '委派记录', '查看会话']) expect(html).toContain(text)
    expect(html).not.toContain('取消委派')
    expect(html).toContain('aria-expanded="false"')
    expect(renderCard({ state: 'failed', error: 'Agent exited unexpectedly' })).toContain('Agent exited unexpectedly')
  })

  it('offers a dialog trigger for parent chats, but never for delegated or special-purpose chats or old cores', () => {
    expect(renderButton()).toContain('aria-haspopup="dialog"')
    expect(renderButton({ ...parent, taskId: task.id })).toContain('委派任务')
    for (const patch of [{ parentConversationId: parent.id }, { helperOf: parent.id }, { discussionId: parent.id }, { squadRunId: parent.id }, { routineId: parent.id }]) {
      expect(renderButton({ ...parent, ...patch })).toBe('')
    }
    connect([])
    expect(renderButton()).toBe('')
  })

  it('hides delegation tabs before the first record arrives while retaining the PR inspector', () => {
    useCore.setState({ conversationInspectorTab: 'delegation', taskInspectorTab: 'delegation' })
    for (const calls of [null, []]) {
      vi.mocked(useAgentCalls).mockReturnValue({ calls, error: null, dispatched: new Map() })
      for (const html of [
        renderToStaticMarkup(createElement(ConversationInspector, { conversation: parent, widthRatio: 0.35, onWidthRatioChange() {} })),
        renderToStaticMarkup(createElement(TaskInspector, { task, widthRatio: 0.35, onWidthRatioChange() {} }))
      ]) {
        expect(html).not.toContain('>委派')
        expect(html).not.toContain('委派记录')
      }
      expect(renderToStaticMarkup(createElement(TaskToolbar, { task, view: 'chat' }))).toContain('aria-label="检查器"')
      expect(renderToStaticMarkup(createElement(ConversationView, { id: parent.id }))).toContain('aria-label="检查器"')
    }
    expect(renderButton()).toContain('委派任务')
  })

  it('offers direct tool selection on new cores and shows the exact handoff boundaries', () => {
    connect(['agent-profiles', 'direct-agent-calls'])
    useCore.setState({ environment: { searchPath: [], checkedAt: 0, checks: [{ tool: 'codex', status: 'ok', version: '1', path: '/bin/codex', signedIn: true }] } })
    const html = renderToStaticMarkup(createElement(DelegationDialog, { conversation: parent, onClose() {}, onHistory() {} }))
    for (const text of ['委派任务', '直接选择工具', '执行工具：Codex', '只读分析', '任务描述', '补充说明', '/w', '不会自动继承聊天历史或图片', '不会另建工作树', '保存当前配置为角色']) expect(html).toContain(text)
    expect(html).not.toContain('尚未检测到可用的执行工具')
  })

  it('uses the saved-role path for older cores and restricted parent roles', () => {
    const render = (conversation = parent) => renderToStaticMarkup(createElement(DelegationDialog, { conversation, onClose() {}, onHistory() {} }))
    expect(render()).toContain('已保存角色')
    expect(render()).not.toContain('直接选择工具')
    connect(['agent-profiles', 'direct-agent-calls'])
    const profile = AgentProfile.parse({ id: parent.id, name: 'Coordinator', agent: 'claude', archivedAt: null, createdAt: 0, updatedAt: 0 })
    const html = render({ ...parent, profile })
    expect(html).toContain('当前角色限制了调用范围')
    expect(html).not.toContain('直接选择工具')
  })

  it('opens the PR panel in task, conversation and split views without other inspector content', () => {
    connect([])
    const other = { ...parent, id: '22222222-2222-4222-8222-222222222222' }
    useCore.setState({ conversations: { [parent.id]: parent, [other.id]: other }, inspectorOpen: true, conversationInspectorOpen: true, taskInspectorTab: 'pull-request', conversationInspectorTab: 'pull-request' })
    for (const html of [
      renderToStaticMarkup(createElement(ConversationView, { id: parent.id })),
      renderToStaticMarkup(createElement(ConversationSplit, { panes: [parent.id, other.id], active: parent.id })),
      renderToStaticMarkup(createElement(TaskChat, { taskId: task.id }))
    ]) expect(html).toContain('PR 链接')
  })

  it('keeps existing history reachable in both inspectors even without git, todos or a helper', () => {
    vi.mocked(useAgentCalls).mockReturnValue({ calls: [{ ...call, state: 'completed' }], error: null, dispatched: new Map() })
    useCore.setState({ conversationInspectorTab: 'delegation', taskInspectorTab: 'delegation' })
    const conversation = renderToStaticMarkup(createElement(ConversationInspector, { conversation: parent, widthRatio: 0.35, onWidthRatioChange() {} }))
    const taskPanel = renderToStaticMarkup(createElement(TaskInspector, { task, widthRatio: 0.35, onWidthRatioChange() {} }))
    for (const html of [conversation, taskPanel]) {
      expect(html).toContain('aria-selected="true">委派')
      expect(html).toContain('委派记录')
      expect(html).not.toContain('<textarea')
    }
    expect(renderToStaticMarkup(createElement(TaskToolbar, { task, view: 'chat' }))).toContain('aria-label="检查器"')
  })

  it('routes history to its owning inspector without changing the other inspector', () => {
    useCore.setState({ taskInspectorTab: 'branch', inspectorOpen: false })
    showAgentCalls('conversation')
    expect(useCore.getState()).toMatchObject({ conversationInspectorOpen: true, conversationInspectorTab: 'delegation', taskInspectorTab: 'branch', inspectorOpen: false })
    showAgentCalls('task')
    expect(useCore.getState()).toMatchObject({ inspectorOpen: true, taskInspectorTab: 'delegation' })
  })

  it('recognizes delivery refs independently of user text and shows a compact inspector link', () => {
    const id = `u:agent-result:${parent.id}`
    expect(isAgentCallResult({ kind: 'user', id })).toBe(true)
    expect(isAgentCallResult({ kind: 'assistant', id })).toBe(false)
    expect(isAgentCallResult({ kind: 'user', id: `u:${parent.id}` })).toBe(false)
    vi.mocked(useAgentCalls).mockReturnValue({ calls: [call], error: null, dispatched: new Map() })
    const item = { kind: 'user', id: `u:agent-result:${call.id}` } as const
    const html = renderToStaticMarkup(createElement(ChatSurfaceContext.Provider, { value: conversationSurface(parent) }, createElement(AgentDelegationResult, { conversationId: parent.id, item })))
    expect(html).toContain('委派结果已返回')
    expect(html).toContain('委派记录')
    expect(html).toContain('审查员 · 查看会话')
  })

  it('renders causality topology in inspector with root and active branch cards', () => {
    vi.mocked(useAgentCalls).mockReturnValue({
      calls: [
        { ...call, id: 'c1', state: 'running' },
        { ...call, id: 'c2', state: 'completed', result: 'All checks passed' }
      ],
      error: null,
      dispatched: new Map()
    })
    const html = renderToStaticMarkup(createElement(AgentCalls, { conversation: parent }))
    expect(html).toContain('拓扑')
    expect(html).toContain('时间线')
    expect(html).toContain('delegation-topology')
    expect(html).toContain('delegation-topology-root')
    expect(html).toContain('Main')
    expect(html).toContain('主会话发起')
    expect(html).toContain('data-active="true"')
    expect(html).toContain('审查员')
    expect(html).toContain('All checks passed')
  })
})
