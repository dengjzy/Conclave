import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatItem, type RemoteParams } from '@conclave/protocol'
import { MobileMessages } from './MobileMessages'

const captured = vi.hoisted(() => ({ nodes: new Array<{ type: unknown; props: Record<string, unknown> }>() }))
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>()
  const capture = (...args: Parameters<typeof runtime.jsx>) => {
    const [type, props] = args
    if (props && typeof props === 'object') captured.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsx(...args)
  }
  return { ...runtime, jsx: capture, jsxs: capture }
})
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args
    if (props && typeof props === 'object') captured.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsxDEV(...args)
  } }
})

type RequestItem = Extract<ChatItem, { kind: 'approval' | 'question' }>
const respond = vi.fn<(item: RequestItem, answer: Omit<RemoteParams<'conversations.respond'>, 'id' | 'requestId'>) => Promise<void>>()
const base = { stageId: 'stage-one', revision: 1, at: 1 }
const assistant = (text: string) => ChatItem.parse({ ...base, id: 'assistant', kind: 'assistant', text, streaming: false })
const reasoning = (id: string, streaming = false) => ChatItem.parse({ ...base, id: `reasoning:${id}`, kind: 'reasoning', text: `思考 ${id}`, streaming })
const tool = (id: string, status: string, extra: Record<string, unknown> = {}) => ChatItem.parse({ ...base, id: `tool:${id}`, kind: 'tool', name: 'Read', title: `工具 ${id}`, status, input: `输入 ${id}`, output: `输出 ${id}`, ...extra })
const approval = (extra: Record<string, unknown> = {}) => ChatItem.parse({ ...base, id: 'approval', kind: 'approval', requestId: 'request-one', tool: 'Bash', title: '允许命令执行？', detail: 'pwd', decisions: ['allow', 'allowForSession', 'deny'], resolution: null, ...extra })
const question = (extra: Record<string, unknown> = {}) => ChatItem.parse({
  ...base, id: 'question', kind: 'question', requestId: 'request-two', resolution: null, answers: null,
  questions: [
    { id: 'single', header: '选项', question: '选一个', options: [{ id: 'option-id', label: '显示文字', description: '说明' }], multiSelect: false },
    { id: 'many', header: '多选', question: '选多个', options: [{ label: '甲', description: null }, { id: 'beta', label: '乙', description: null }], multiSelect: true }
  ], ...extra
})
function render(items: ChatItem[], busy = false) {
  captured.nodes.length = 0
  return renderToStaticMarkup(createElement(MobileMessages, { items, busy, respond }))
}
function label(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(label).join('')
  if (value && typeof value === 'object' && 'props' in value && value.props && typeof value.props === 'object' && 'children' in value.props) return label(value.props.children)
  return ''
}
function props(type: string, match: (value: Record<string, unknown>) => boolean = () => true) {
  const found = captured.nodes.find((entry) => entry.type === type && match(entry.props))
  if (!found) throw new Error(`missing ${type}`)
  return found.props
}
function click(text: string) {
  const onClick = props('button', (value) => label(value.children) === text).onClick
  if (typeof onClick !== 'function') throw new Error('missing click handler')
  onClick()
}
function submit(values: Record<string, string[]>) {
  vi.stubGlobal('FormData', class {
    get(key: string) { return values[key]?.[0] ?? null }
    getAll(key: string) { return values[key] ?? [] }
  })
  const onSubmit = props('form').onSubmit
  if (typeof onSubmit !== 'function') throw new Error('missing submit handler')
  const preventDefault = vi.fn()
  onSubmit({ preventDefault, currentTarget: {} })
  expect(preventDefault).toHaveBeenCalledOnce()
}

beforeEach(() => { respond.mockReset(); respond.mockResolvedValue(undefined) })
afterEach(() => { vi.unstubAllGlobals() })

describe('MobileMessages reading', () => {
  it('renders assistant GFM and preserves user text without repeated role labels', () => {
    const html = render([
      ChatItem.parse({ ...base, id: 'user', kind: 'user', text: '**原样**\n<b>不是 HTML</b>' }),
      assistant('**重点** 和 `代码`\n\n- 第一项\n\n| A | B |\n| --- | --- |\n| 一 | 二 |')
    ])
    expect(html).toContain('**原样**\n&lt;b&gt;不是 HTML&lt;/b&gt;')
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<code>代码</code>')
    expect(html).toContain('<li>第一项</li>')
    expect(html).toContain('<table>')
    expect(html).not.toContain('<small>你</small>')
    expect(html).not.toContain('<small>Agent</small>')
  })

  it('does not execute HTML or load images and only links to safe external URLs', () => {
    const html = render([assistant('<script>alert(1)</script>\n\n<img src="https://tracker.test/pixel" onerror="alert(1)">\n\n[文档](https://example.com/docs)\n\n![截图](https://example.com/image.png)\n\n[坏链接](javascript:alert%281%29)\n\n[数据](data:text/html,hello)')])
    expect(html).not.toMatch(/<(script|img)\b/)
    expect(html).not.toContain('tracker.test')
    expect(html).not.toMatch(/href="(?:javascript|data):/)
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="nofollow noreferrer noopener">文档</a>')
    expect(html).toContain('<a href="https://example.com/image.png" target="_blank" rel="nofollow noreferrer noopener">图片：截图</a>')
  })

  it('keeps linked images as one safe link rather than nesting anchors', () => {
    const html = render([assistant('[**![标志](https://image.test/logo.png)**](https://example.com/)')])
    expect(html.match(/<a\b/g)).toHaveLength(1)
    expect(html).toContain('href="https://example.com/"')
    expect(html).toContain('图片：标志')
    expect(html).not.toContain('href="https://image.test/logo.png"')
  })

  it('folds only adjacent completed process items, preserving messages and pending requests in order', () => {
    const html = render([reasoning('one'), tool('one', 'done'), reasoning('two'), assistant('最终答复'), approval(), tool('two', 'done')])
    const groups = [...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)]
    expect(groups).toHaveLength(2)
    const first = groups[0]?.[1] ?? ''
    expect(first).toContain('处理过程 · 3 项')
    expect(first.indexOf('思考 one')).toBeLessThan(first.indexOf('工具 one'))
    expect(first.indexOf('工具 one')).toBeLessThan(first.indexOf('思考 two'))
    expect(first).not.toContain('最终答复')
    expect(first).not.toContain('允许命令执行？')
    expect(html.indexOf('</details>')).toBeLessThan(html.indexOf('最终答复'))
    expect(html.indexOf('最终答复')).toBeLessThan(html.indexOf('允许命令执行？'))
    expect(html.indexOf('允许命令执行？')).toBeLessThan(html.indexOf('工具 two'))
    expect(props('button', (value) => label(value.children) === '允许一次').disabled).toBe(false)
  })

  it('keeps running processes visible and never combines stages', () => {
    const html = render([tool('one', 'done'), tool('running', 'running'), reasoning('stream', true), tool('two', 'done'), tool('next-stage', 'done', { stageId: 'stage-two' })])
    const groups = [...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)]
    expect(groups).toHaveLength(3)
    for (const group of groups) {
      expect(group[1]).not.toContain('工具 running')
      expect(group[1]).not.toContain('思考 stream')
    }
    expect(html).toContain('data-status="running"')
    expect(html).toContain('正在思考')
  })

  it('surfaces process exceptions but retains the existing command exit semantics', () => {
    const html = render([tool('failed', 'failed'), tool('denied', 'denied'), tool('stopped', 'interrupted'), tool('nonzero', 'failed', { name: 'Bash', execution: { status: 'completed', exitCode: 1 } })])
    expect(html).toContain('处理过程 · 4 项 · 1 失败 · 1 已拒绝 · 1 已停止')
    expect(html).toContain('已完成 · 退出码 1')
  })
})

describe('MobileMessages responses', () => {
  it('submits the original approval choice id and decision', () => {
    const item = approval({ choices: [{ id: 'allow-prefix', label: '允许这类命令', decision: 'allowForSession', grants: [] }] })
    render([item])
    click('允许这类命令')
    expect(respond).toHaveBeenCalledWith(item, { decision: 'allowForSession', choice: 'allow-prefix' })
  })

  it('keeps plain approval decisions and blocks responses while busy or resolved', () => {
    const item = approval()
    render([item]); click('拒绝')
    expect(respond).toHaveBeenCalledWith(item, { decision: 'deny' })
    respond.mockClear()
    render([item], true); click('允许一次')
    expect(respond).not.toHaveBeenCalled()
    const html = render([approval({ resolution: 'cancelled' })])
    expect(html).toContain('已取消')
    expect(captured.nodes.filter((entry) => entry.type === 'button')).toHaveLength(0)
  })

  it('submits option ids or labels and lets a trimmed custom answer override selections', () => {
    const item = question()
    render([item])
    expect(props('input', (value) => value.name === 'single').value).toBe('option-id')
    expect(props('input', (value) => value.name === 'many').type).toBe('checkbox')
    submit({ single: ['option-id'], many: ['甲', 'beta'], 'single:text': ['  自定义回答  '] })
    expect(respond).toHaveBeenCalledWith(item, { decision: 'allow', answers: { single: ['自定义回答'], many: ['甲', 'beta'] } })
  })

  it('blocks busy or resolved question submits and shows saved answers', () => {
    render([question()], true)
    submit({ single: ['option-id'] })
    expect(respond).not.toHaveBeenCalled()
    const html = render([question({ resolution: 'answered', answers: { single: ['option-id'], many: ['自定义内容'] } })])
    submit({ single: ['option-id'] })
    expect(respond).not.toHaveBeenCalled()
    expect(props('input', (value) => value.name === 'single').defaultChecked).toBe(true)
    expect(props('input', (value) => value.name === 'many:text').defaultValue).toBe('自定义内容')
    expect(html).toContain('已回答')
    expect(render([question({ resolution: 'cancelled' })])).toContain('已取消')
  })
})
