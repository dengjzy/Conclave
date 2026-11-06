import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopNodeDialog, DesktopNodeNotice, DesktopNodeSwitcher } from './DesktopNodeSwitcher'

const hooks = vi.hoisted(() => {
  const nodes: Array<{ type: unknown; props: Record<string, unknown> }> = []
  const queued: Array<() => void> = []
  return { cursor: 0, values: new Map<number, unknown>(), nodes, effects: new Map<number, { run: () => (() => void) | void; cleanup: (() => void) | void }>(), queued }
})
const state = vi.hoisted(() => ({
  configured: true, target: 'connect', localAvailable: false, paused: false, connecting: false,
  message: '', error: '', revision: 0, dialogOpen: true,
  registry: { hosts: [{ id: 'saved', name: '工作电脑', deviceName: '浏览器', lastConnectedAt: null }], platform: { deviceName: '测试电脑' }, isPairing: false, invitationName: '', invitationProblem: '', storageNotice: '' }
}))
const actions = vi.hoisted(() => ({ pair: vi.fn<() => Promise<void>>(), remove: vi.fn<() => Promise<void>>(), select: vi.fn(), pause: vi.fn(), resume: vi.fn() }))
vi.mock('../core-store', () => ({ useCore: (select: (state: { connection: string }) => unknown) => select({ connection: 'connected' }) }))
vi.mock('../browser-occlusion', () => ({ useOccludesBrowser: () => {} }))
vi.mock('../remote/desktop-node-session', () => ({
  useDesktopNodeSession: Object.assign((select?: (value: typeof state) => unknown) => select ? select(state) : state, { getState: () => state, setState: (patch: Partial<typeof state>) => Object.assign(state, patch) }),
  pairDesktopNode: actions.pair, removeDesktopNode: actions.remove, switchDesktopNode: actions.select,
  pauseDesktopNode: actions.pause, resumeDesktopNode: actions.resume, desktopNodeUrl: () => 'https://client.example.test/conclave'
}))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return { ...react,
    useState(initial: unknown) {
      const index = hooks.cursor++
      if (!hooks.values.has(index)) hooks.values.set(index, typeof initial === 'function' ? initial() : initial)
      return [hooks.values.get(index), (value: unknown) => hooks.values.set(index, typeof value === 'function' ? value(hooks.values.get(index)) : value)]
    },
    useRef(initial: unknown) {
      const index = hooks.cursor++
      if (!hooks.values.has(index)) hooks.values.set(index, { current: initial })
      return hooks.values.get(index)
    },
    useEffect(effect: () => (() => void) | void) {
      const index = hooks.cursor++
      if (!hooks.effects.has(index)) hooks.queued.push(() => hooks.effects.set(index, { run: effect, cleanup: effect() }))
    }
  }
})
vi.mock('react/jsx-runtime', async (original) => {
  const runtime = await original<typeof import('react/jsx-runtime')>()
  const capture = (...args: Parameters<typeof runtime.jsx>) => {
    const [type, props] = args
    if (props && typeof props === 'object') hooks.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsx(...args)
  }
  return { ...runtime, jsx: capture, jsxs: capture }
})
vi.mock('react/jsx-dev-runtime', async (original) => {
  const runtime = await original<typeof import('react/jsx-dev-runtime')>()
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args
    if (props && typeof props === 'object') hooks.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsxDEV(...args)
  } }
})
function render() {
  hooks.cursor = 0; hooks.nodes = []
  const html = renderToStaticMarkup(createElement(DesktopNodeDialog))
  for (const effect of hooks.queued.splice(0)) effect()
  return html
}
function node(predicate: (node: { type: unknown; props: Record<string, unknown> }) => boolean) {
  const found = hooks.nodes.find(predicate)
  if (!found) throw new Error('UI element not found')
  return found
}
function invoke(props: Record<string, unknown>, event = 'onClick', value: unknown = {}) {
  const handler = props[event]
  if (typeof handler !== 'function') throw new Error(`Missing ${event}`)
  handler(value)
}
async function settle() { for (let at = 0; at < 8; at++) await Promise.resolve() }
beforeEach(() => {
  vi.clearAllMocks(); hooks.cursor = 0; hooks.values.clear(); hooks.effects.clear(); hooks.queued = []; hooks.nodes = []
  Object.assign(state, { target: 'connect', localAvailable: false, paused: false, connecting: false, error: null, dialogOpen: true })
  Object.assign(state.registry, { isPairing: false, invitationName: '', invitationProblem: '', storageNotice: '' })
  actions.pair.mockResolvedValue(); actions.remove.mockResolvedValue()
})
afterEach(() => { for (const effect of hooks.effects.values()) effect.cleanup?.() })

describe('desktop node controls', () => {
  it('shows only saved nodes on public clients and displays the selected node status', () => {
    expect(render()).toContain('工作电脑')
    expect(render()).not.toContain('本机 Conclave')
    state.target = 'saved'
    expect(renderToStaticMarkup(createElement(DesktopNodeSwitcher))).toContain('切换节点：工作电脑，已连接')
    expect(renderToStaticMarkup(createElement(DesktopNodeNotice))).toContain('文件、终端、Git 和主机管理请在节点主机操作')
  })
  it('selects a saved node through the document switch action', () => {
    render()
    const row = node((entry) => entry.type === 'button' && entry.props['aria-current'] === undefined && !entry.props.className && entry.props.type === 'button')
    invoke(row.props)
    expect(actions.select).toHaveBeenCalledWith('saved')
  })
  it('makes a pairing failure visible and permits retry after StrictMode effect replay', async () => {
    render()
    for (const effect of hooks.effects.values()) { effect.cleanup?.(); effect.cleanup = effect.run() }
    invoke(node((entry) => entry.type === 'textarea').props, 'onChange', { target: { value: 'https://computer.example.test/#pair=opaque' } })
    render()
    actions.pair.mockRejectedValueOnce(new Error('配对已失效，请生成新链接'))
    invoke(node((entry) => entry.type === 'form').props, 'onSubmit', { preventDefault() {} })
    await settle()
    const html = render()
    expect(html).toContain('role="alert">配对已失效，请生成新链接')
    expect(node((entry) => entry.props.type === 'submit').props.disabled).toBe(false)
    expect(actions.pair).toHaveBeenCalledWith('https://computer.example.test/#pair=opaque', '测试电脑', undefined)
  })
  it('confirms an imported fragment without requiring a second paste', async () => {
    state.registry.isPairing = true; state.registry.invitationName = '扫码电脑'
    expect(render()).toContain('扫码电脑')
    expect(hooks.nodes.some((entry) => entry.type === 'textarea')).toBe(false)
    invoke(node((entry) => entry.type === 'form').props, 'onSubmit', { preventDefault() {} })
    await settle()
    expect(actions.pair).toHaveBeenCalledWith('', '测试电脑', '扫码电脑')
  })
  it('removes only the selected library entry and prevents concurrent form submission', async () => {
    render()
    let finish: () => void = () => {}
    actions.remove.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    invoke(node((entry) => entry.props['aria-label'] === '移除节点 工作电脑').props)
    render()
    expect(node((entry) => entry.props['aria-label'] === '关闭节点连接').props.disabled).toBe(true)
    invoke(node((entry) => entry.type === 'form').props, 'onSubmit', { preventDefault() {} })
    expect(actions.pair).not.toHaveBeenCalled()
    finish(); await settle()
    expect(actions.remove).toHaveBeenCalledWith('saved')
  })
})
