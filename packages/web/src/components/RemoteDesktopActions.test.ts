import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { Conversation, createRpcClient, RpcRequest, Task, type RpcConnection } from '@conclave/protocol'
import { useCore } from '../core-store'
import { proposeHandoff, useHandoffs } from '../chat-handoff'
import { TaskLaunchDialog } from './TaskLaunchDialog'
import { NewTaskDialog } from './NewTaskDialog'
import { useComposerHandoff, type ComposerHandoff } from './ChatHandoff'

vi.hoisted(() => {
  vi.stubGlobal('window', { location: { search: '?node=saved' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('navigator', { userAgent: 'Linux', platform: 'Linux' })
})
const captured = vi.hoisted(() => {
  const nodes: Array<{ type: unknown; props: Record<string, unknown> }> = []
  return { nodes }
})
vi.mock('zustand', async (original) => {
  const zustand = await original<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
vi.mock('../browser-occlusion', () => ({ useOccludesBrowser: () => {} }))
vi.mock('../agent-models', async (original) => ({ ...await original<typeof import('../agent-models')>(), useAgentCatalog: () => null }))
vi.mock('./AgentQuota', async (original) => ({ ...await original<typeof import('./AgentQuota')>(), useRecommendation: () => null, AgentQuotaHint: () => null, confirmQuota: () => true }))
vi.mock('./MarkdownEditor', () => ({ MarkdownEditor: () => null }))
vi.mock('react/jsx-dev-runtime', async (original) => {
  const runtime = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args
    if (props && typeof props === 'object') captured.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsxDEV(...args)
  } }
})
vi.mock('react/jsx-runtime', async (original) => {
  const runtime = await original<typeof import('react/jsx-runtime')>()
  const capture = (...args: Parameters<typeof runtime.jsx>) => {
    const [type, props] = args
    if (props && typeof props === 'object') captured.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsx(...args)
  }
  return { ...runtime, jsx: capture, jsxs: capture }
})
const task = Task.parse({ id: 'task-one', title: 'Remote task', details: '', status: 'pending', repos: [{ path: '/registered', worktreePath: null, branch: null }], dependsOn: [], agent: 'codex', createdAt: 0, updatedAt: 0 })
const conversation = Conversation.parse({ id: '11111111-1111-4111-8111-111111111111', title: 'Remote chat', titleLocked: false, agent: 'claude', workspacePath: '/registered', projectPaths: ['/registered'], managedWorkspace: false, sessionId: null, chatOptions: { permissionMode: 'acceptEdits', model: null, effort: null }, createdAt: 0, updatedAt: 0 })
function connect() {
  const sent: ReturnType<typeof RpcRequest.parse>[] = []
  const client = createRpcClient((frame) => sent.push(RpcRequest.parse(JSON.parse(frame))))
  const rpc: RpcConnection = { ...client, features: ['chat-options', 'handoff-mode', 'handoff-model', 'task-handoff'], close() {}, closed: new Promise(() => {}) }
  useCore.setState({ rpc, connection: 'connected', tasks: { [task.id]: task }, conversations: { [conversation.id]: conversation } })
  return { rpc, sent }
}
function props(predicate: (entry: { type: unknown; props: Record<string, unknown> }) => boolean) {
  const found = captured.nodes.find(predicate)
  if (!found) throw new Error('Missing UI element')
  return found.props
}
function invoke(properties: Record<string, unknown>, name: string) {
  const handler = properties[name]
  if (typeof handler !== 'function') throw new Error('Missing handler')
  handler({ preventDefault() {} })
}
beforeEach(() => { useCore.setState(useCore.getInitialState(), true); useHandoffs.setState({}, true); captured.nodes = [] })

describe('remote original desktop actions', () => {
  it('shows the actual ask-only task launch and sends only the task id', () => {
    const { sent } = connect()
    const html = renderToStaticMarkup(createElement(TaskLaunchDialog, { taskId: task.id }))
    expect(html).toContain('启动（逐次询问）')
    expect(props((entry) => entry.props.label === 'Agent').disabled).toBe(true)
    invoke(props((entry) => entry.type === 'form'), 'onSubmit')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ method: 'tasks.start', params: { id: task.id } })
    expect(Object.keys(sent[0]?.params ?? {})).toEqual(['id'])
  })
  it('keeps tasks missing an agent on the host configuration path', () => {
    connect(); useCore.setState({ tasks: { [task.id]: { ...task, agent: null } } })
    const html = renderToStaticMarkup(createElement(TaskLaunchDialog, { taskId: task.id }))
    expect(html).toContain('请先在节点主机为任务配置单个 Agent')
    expect(props((entry) => entry.props.type === 'submit').disabled).toBe(true)
  })
  it('requires agent and project before remote task creation and omits unavailable controls', () => {
    connect(); useCore.setState({ newTaskDraft: { title: 'Remote task', repos: [], agent: null } })
    const html = renderToStaticMarkup(createElement(NewTaskDialog))
    expect(html).toContain('请选择 Agent 和节点已有项目')
    expect(props((entry) => entry.props.className === 'button primary modal-submit').disabled).toBe(true)
    expect(html).not.toContain('更多选项')
    expect(props((entry) => entry.props.className === 'new-task-attach').disabled).toBe(true)
  })
  it('hands off without null model overrides or unsafe inherited permissions', async () => {
    const { rpc, sent } = connect()
    proposeHandoff(conversation.id, 'codex')
    let handoff: ComposerHandoff | undefined
    function Probe() { handoff = useComposerHandoff(conversation); return null }
    renderToStaticMarkup(createElement(Probe))
    const action = handoff
    if (!action) throw new Error('No handoff')
    expect(action.target?.mode).toBe('ask')
    const sending = action.send('请继续')
    expect(sent[0]).toMatchObject({ method: 'conversations.handoff', params: { id: conversation.id, agent: 'codex', permissionMode: 'ask' } })
    expect(sent[0]?.params).not.toHaveProperty('model')
    expect(sent[0]?.params).not.toHaveProperty('effort')
    expect(sent[0]?.params).not.toHaveProperty('allowBypass')
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: { ...conversation, agent: 'codex' } }))
    expect(await sending).toBe(true)
  })
})
