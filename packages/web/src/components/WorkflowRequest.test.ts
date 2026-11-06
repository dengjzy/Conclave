import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@conclave/protocol'
import type { WorkflowEvent } from '../workflow-events'
import { WorkflowRequest } from './WorkflowRequest'

vi.mock('../core-store', () => ({ perform: vi.fn() }))
const item: Extract<ChatItem, { kind: 'approval' }> = {
  id: 'approval', stageId: 'current', revision: 1, at: 1, kind: 'approval', requestId: 'number:1', tool: 'commandExecution', title: 'git grep readonly', detail: null, toolItemId: 'tool:1', decisions: ['allow', 'deny'], resolution: null,
  choices: [
    { id: 'always', decision: 'allowForSession', label: 'Allow Always', grants: [] },
    { id: 'once', decision: 'allow', label: 'Allow Once', grants: [] },
    { id: 'deny', decision: 'deny', label: 'Deny', grants: [] }
  ]
}
const event: WorkflowEvent = { key: 'task/current/approval', laneId: 'task', taskId: 'task', stageId: 'current', at: 1, agent: 'antigravity', kind: 'question', title: item.title, detail: '', phase: 'awaiting', item }
const render = (value = event, items: ChatItem[] = [], connected = true) => renderToStaticMarkup(createElement(WorkflowRequest, { event: value, items, connected, conversationId: 'conversation' }))
describe('workflow request', () => {
  it('offers a one-time decision in the workflow without broadening permissions', () => {
    const html = render()
    expect(html).toContain('Allow Once')
    expect(html).not.toContain('Allow Always')
    expect(html).toContain('git grep readonly')
  })
  it('keeps old stages and resolved requests as non-interactive records', () => {
    expect(render({ ...event, phase: 'recorded' })).toBe('')
    expect(render({ ...event, item: { ...item, resolution: 'allowed' } })).toBe('')
  })
  it('does not mix tools with reused IDs from a previous stage', () => {
    const tool: Extract<ChatItem, { kind: 'tool' }> = { id: 'tool:1', stageId: 'old', revision: 1, at: 0, kind: 'tool', name: 'commandExecution', title: 'old', input: 'OLD_COMMAND', status: 'done', output: null, diffs: [] }
    expect(render(event, [tool])).not.toContain('OLD_COMMAND')
    expect(render(event, [tool, { ...tool, stageId: 'current', input: 'CURRENT_COMMAND' }])).toContain('CURRENT_COMMAND')
  })
  it('disables submission while disconnected', () => {
    expect(render(event, [], false)).toContain('disabled=""')
  })
})
