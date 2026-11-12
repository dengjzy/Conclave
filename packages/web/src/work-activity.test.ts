import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Task, type Conversation } from '@conclave/protocol'
import { WorkingSummary } from './components/WorkingSummary'
import { TaskActivity } from './components/TaskActivity'
import { conversationActivity, taskActivity } from './work-activity'

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const conversation = (n: number, chat: Conversation['chat']): Conversation => ({ id: id(n), title: '', titleLocked: true, agent: 'codex', workspacePath: '/w', projectPaths: ['/w'], managedWorkspace: false, sessionId: 's', createdAt: 0, updatedAt: 0, chat })
const task = Task.parse({ id: 'task', title: 'Export', details: '', status: 'running', agent: 'codex', repos: [], dependsOn: [], conversationId: id(7), createdAt: 0, updatedAt: 0 })

describe('who is at work', () => {
  it('reads a chat\'s turn: what it is on, or what it asked', () => {
    expect(conversationActivity(conversation(7, { turn: 'running', doing: { tool: 'Bash', title: 'pnpm test' } }), 'codex')).toEqual({ state: 'running', workers: [{ agent: 'codex', name: 'Codex' }], detail: '命令 pnpm test' })
    expect(conversationActivity(conversation(7, { turn: 'awaiting', request: { requestId: 'r', kind: 'approval', tool: 'Bash', title: 'git push', decisions: [], open: 1 } }), 'codex')).toMatchObject({ state: 'awaiting', detail: 'git push' })
    expect(conversationActivity(conversation(7, { turn: 'idle' }), 'codex')).toBeNull()
    expect(taskActivity(task, { [id(7)]: conversation(7, { turn: 'running' }) })).toMatchObject({ state: 'running', detail: null })
  })

  it('names who works, or counts them past two', () => {
    const html = (names: string[]) => renderToStaticMarkup(createElement(WorkingSummary, { activity: { state: 'running', workers: names.map((name) => ({ agent: 'codex' as const, name })), detail: '开发：命令 pnpm test' } }))
    expect(html(['开发', '队长'])).toContain('开发、队长 工作中')
    expect(html(['开发', '队长', '审查'])).toContain('3 人工作中')
    expect(html(['开发'])).toContain('开发：命令 pnpm test')
  })

  it('shows only the current action on a card, retaining the worker in its accessible description', () => {
    const html = renderToStaticMarkup(createElement(TaskActivity, { activity: { state: 'running', workers: [{ agent: 'claude', name: 'Claude Code' }], detail: '分析 Agent 额度用量' } }))
    expect(html).toContain('class="task-card-activity-text">分析 Agent 额度用量</span>')
    expect(html).toContain('aria-label="Claude Code · 执行中：分析 Agent 额度用量"')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('working-label')
  })

  it('keeps waiting requests explicit and provides a status when there is no current action', () => {
    const render = (state: 'running' | 'awaiting', detail: string | null, count = 1) => renderToStaticMarkup(createElement(TaskActivity, { activity: { state, workers: Array.from({ length: count }, () => ({ agent: 'codex' as const, name: 'Codex' })), detail } }))
    expect(render('awaiting', '允许运行 pnpm test？')).toContain('等你回答：允许运行 pnpm test？</span>')
    expect(render('awaiting', null)).toContain('class="task-card-activity-text">等你回答</span>')
    expect(render('running', null)).toContain('class="task-card-activity-text">执行中</span>')
    expect(render('running', '  ', 3)).toContain('class="task-card-activity-text">3 个 Agent 执行中</span>')
  })
})
