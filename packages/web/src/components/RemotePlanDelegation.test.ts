import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { Conversation, createRpcClient, remoteOperationSchemas, type RpcConnection } from '@conclave/protocol'
import { useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { useChat } from '../chat-state'
import { ChatPlanCard } from './ChatPlan'
import { DelegationDialog } from './AgentDelegation'
import { ChatSurfaceContext, conversationSurface } from './chat-surface'

const hooks = vi.hoisted(() => {
  const nodes: Array<{ type: unknown; props: Record<string, unknown> }> = []
  return { remote: true, cursor: 0, values: new Map<number, unknown>(), nodes }
})
vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})
vi.mock('../remote/desktop-node-mode', () => ({ isRemoteDesktopNode: () => hooks.remote }))
vi.mock('../agent-models', async (importOriginal) => ({ ...await importOriginal<typeof import('../agent-models')>(), useAgentCatalog: () => null }))
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useState(initial: unknown) {
    const index = hooks.cursor++
    if (!hooks.values.has(index)) hooks.values.set(index, typeof initial === 'function' ? initial() : initial)
    return [hooks.values.get(index), (next: unknown) => hooks.values.set(index, typeof next === 'function' ? next(hooks.values.get(index)) : next)]
  } }
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
  const capture = (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args
    if (props && typeof props === 'object') hooks.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsxDEV(...args)
  }
  return { ...runtime, jsxDEV: capture }
})

const conversation = Conversation.parse({ id: '11111111-1111-4111-8111-111111111111', title: 'Remote chat', titleLocked: false, agent: 'codex', workspacePath: '/project', projectPaths: ['/project'], managedWorkspace: false, sessionId: null, createdAt: 1, updatedAt: 1 })
const plan = { id: 'plan', stageId: 'stage', revision: 1, at: 1, kind: 'approval', requestId: 'approval', tool: 'ExitPlanMode', toolItemId: null, title: 'Plan', detail: null, decisions: ['allow', 'allowForSession', 'deny'], resolution: null, runModes: ['ask', 'acceptEdits', 'bypass'] } as const
const sent: Array<{ id: number; method: string; params: unknown }> = []
function render(element: ReturnType<typeof createElement>) {
  hooks.cursor = 0
  hooks.nodes.length = 0
  return renderToStaticMarkup(element)
}
function clickSubmit() {
  const button = hooks.nodes.findLast((node) => node.type === 'button' && node.props.className === 'button primary')
  if (!button || typeof button.props.onClick !== 'function') throw new Error('missing submit button')
  button.props.onClick()
}
function fillField(rows: number, value: string) {
  const field = hooks.nodes.find((node) => node.type === 'textarea' && node.props.rows === rows)
  if (!field || typeof field.props.onChange !== 'function') throw new Error('missing field')
  field.props.onChange({ target: { value } })
}
function submitDelegation() {
  const form = hooks.nodes.find((node) => node.type === 'form')
  if (!form || typeof form.props.onSubmit !== 'function') throw new Error('missing form')
  form.props.onSubmit({ preventDefault() {} })
}

beforeEach(() => {
  hooks.remote = true
  hooks.cursor = 0
  hooks.values.clear()
  hooks.nodes.length = 0
  sent.length = 0
  useCore.setState(useCore.getInitialState(), true)
  useChat.setState({}, true)
  usePreferences.setState({ planRunMode: 'bypass' })
  const client = createRpcClient((frame) => {
    const request = JSON.parse(frame)
    sent.push(request)
    queueMicrotask(() => client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })))
  })
  const rpc: RpcConnection = { ...client, features: ['plan-modes', 'chat-options', 'agent-profiles', 'direct-agent-calls'], close() {}, closed: new Promise(() => {}) }
  useCore.setState({ rpc, conversations: { [conversation.id]: conversation }, environment: { searchPath: [], checkedAt: 1, checks: [{ tool: 'codex', status: 'ok', version: '1', path: '/bin/codex', signedIn: true }] } })
})

it('offers explicit ask-before-action plan approval remotely and sends no unsupported mode', async () => {
  const surface = conversationSurface(conversation)
  const html = render(createElement(ChatSurfaceContext.Provider, { value: surface }, createElement(ChatPlanCard, { conversationId: conversation.id, item: { ...plan, decisions: [...plan.decisions], runModes: [...plan.runModes] }, modes: ['ask', 'acceptEdits', 'bypass'] })))
  expect(html).toContain('按计划执行，改文件、跑命令前逐项确认')
  expect(html).not.toContain('选择执行时的权限')
  expect(html).not.toContain('执行计划，自动接受文件编辑')
  clickSubmit()
  await Promise.resolve()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ method: 'conversations.respond', params: { id: conversation.id, requestId: plan.requestId, decision: 'allow' } })
  expect(remoteOperationSchemas['conversations.respond'].params.safeParse(sent[0]?.params).success).toBe(true)
})

it('keeps local plan permissions and never offers remote execution for task-only save/squad paths', () => {
  hooks.remote = false
  const element = createElement(ChatSurfaceContext.Provider, { value: conversationSurface(conversation) }, createElement(ChatPlanCard, { conversationId: conversation.id, item: { ...plan, decisions: [...plan.decisions], runModes: [...plan.runModes] }, modes: ['ask', 'bypass'] }))
  expect(render(element)).toContain('选择执行时的权限')
  hooks.remote = true
  hooks.values.clear()
  const surface = { ...conversationSurface(conversation), savePlan: async () => {} }
  const html = render(createElement(ChatSurfaceContext.Provider, { value: surface }, createElement(ChatPlanCard, { conversationId: conversation.id, item: { ...plan, decisions: [...plan.decisions], runModes: [...plan.runModes] }, modes: ['ask'] })))
  expect(html).not.toContain('按计划执行，改文件、跑命令前逐项确认')
  expect(html).not.toContain('先保存计划')
  expect(html).toContain('继续规划')
})

it('enforces the remote delegation limit across goal, separator and context without truncating input', () => {
  const element = createElement(DelegationDialog, { conversation, onClose() {}, onHistory() {} })
  render(element)
  fillField(3, 'g'.repeat(9990))
  fillField(2, 'c'.repeat(9))
  let html = render(element)
  expect(html).not.toContain('保存当前配置为角色')
  expect(html).toContain('10001 / 10000')
  expect(html).toContain('aria-invalid="true"')
  expect(hooks.nodes.find((node) => node.type === 'button' && node.props.type === 'submit')?.props.disabled).toBe(true)
  submitDelegation()
  expect(sent).toHaveLength(0)
  fillField(2, 'c'.repeat(8))
  html = render(element)
  expect(html).toContain('10000 / 10000')
  expect(hooks.nodes.find((node) => node.type === 'button' && node.props.type === 'submit')?.props.disabled).toBe(false)
  submitDelegation()
  expect(sent).toHaveLength(1)
  expect(sent[0]?.method).toBe('agentCalls.dispatch')
  expect(remoteOperationSchemas['agentCalls.dispatch'].params.safeParse(sent[0]?.params).success).toBe(true)
})

it('retains the existing 20000-character delegation budget on the local node', () => {
  hooks.remote = false
  const element = createElement(DelegationDialog, { conversation, onClose() {}, onHistory() {} })
  render(element)
  fillField(3, 'g'.repeat(10000))
  fillField(2, 'c'.repeat(9998))
  const html = render(element)
  expect(html).toContain('保存当前配置为角色')
  expect(html).not.toContain('/ 10000')
  expect(hooks.nodes.find((node) => node.type === 'button' && node.props.type === 'submit')?.props.disabled).toBe(false)
})
