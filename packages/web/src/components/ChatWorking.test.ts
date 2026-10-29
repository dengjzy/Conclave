import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@conclave/protocol'
import { ChatWorking } from './ChatWorking'
import { StopBackground } from '../background-work'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const command = (id: string, changes: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', id, stageId: 's', revision: 1, at: Date.now() - 3 * 60_000, name: 'Bash', title: 'pnpm dev',
  description: `Run ${id}`, input: 'env -u X HOME=/tmp/demo pnpm dev > /tmp/out.log 2>&1', status: 'running', output: null, diffs: [], background: true, ...changes
})
const render = (background: ToolItem[], phase: 'waiting' | 'thinking' = 'waiting') =>
  renderToStaticMarkup(createElement(ChatWorking, { phase, tokens: null, background, since: Date.now(), onReveal: () => {} }))

describe('the working line\'s background work', () => {
  it('names the one command running, with the command itself as its tooltip and how long it has run', () => {
    const html = render([command('server')])
    expect(html).toContain('后台运行中：')
    expect(html).toContain('>Run server</button>')
    expect(html).toContain('title="pnpm dev"')
    expect(html).toContain('已运行 3 分钟')
  })

  it('offers to stop the one running, where the agent lets the chat stop it', () => {
    const stoppable = (background: ToolItem[]) => renderToStaticMarkup(createElement(StopBackground.Provider, { value: async () => true },
      createElement(ChatWorking, { phase: 'waiting', tokens: null, background, since: Date.now(), onReveal: () => {} })))
    expect(stoppable([command('server', { stoppable: true })])).toContain('aria-label="停止 Run server">停止</button>')
    expect(stoppable([command('server')])).not.toContain('chat-background-stop')
    expect(render([command('server', { stoppable: true })])).not.toContain('chat-background-stop')
  })

  it('counts several, behind a way to list them', () => {
    const html = render([command('server'), command('desktop')])
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('2 个命令')
    expect(html).not.toContain('Run server')
  })

  it('warns once a limit the agent set is close, and stays quiet before', () => {
    expect(render([command('server', { backgroundLimitMs: 6 * 60_000 })])).toContain('分钟后到上限')
    expect(render([command('server', { backgroundLimitMs: 2 * 3_600_000 })])).not.toContain('到上限')
  })

  it('names background work beside the step while the turn itself runs', () => {
    const html = render([command('server')], 'thinking')
    expect(html).toContain('后台：')
    expect(html).toContain('Run server')
  })
})
