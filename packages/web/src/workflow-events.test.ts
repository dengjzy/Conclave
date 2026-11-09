import { describe, expect, it } from 'vitest'
import { ChatItem, Task, type ConversationStage } from '@conclave/protocol'
import { activeWorkflowEvent, workflowEvents, workflowItem } from './workflow-events'
const task = Task.parse({ id: 'task', title: 'A', details: '', status: 'running', repos: [], dependsOn: [], agent: 'codex', conversationId: 'chat', createdAt: 1, updatedAt: 1 })
const liveConversation = { id: 'chat', title: 'A', titleLocked: true, agent: 'codex' as const, workspacePath: '/w', managedWorkspace: false, projectPaths: [], sessionId: 's', chat: { turn: 'running' as const }, createdAt: 1, updatedAt: 1 }
const stage: ConversationStage = { id: 'stage', conversationId: 'chat', agent: 'claude', sessionId: 's', providerSessionId: null, receivedSequence: 0, startedAt: 1, endedAt: 9, exitCode: 0 }
const tool = (status: 'done' | 'failed' | 'running') => ChatItem.parse({ id: 'tool', revision: 0, stageId: 'stage', at: 2, kind: 'tool', name: 'Bash', title: 'pnpm test', input: null, output: 'result', status, diffs: [] })
describe('workflow event history', () => {
  it('keeps actual command failures distinct from completion and file changes', () => {
    expect(workflowItem(tool('failed'))).toMatchObject({ kind: 'command', phase: 'failed' })
    expect(workflowItem(tool('done'))).toMatchObject({ kind: 'command', phase: 'ended' })
    const edit = ChatItem.parse({ ...tool('done'), name: 'Edit', diffs: [{ path: 'a.ts', change: 'update', patch: '-1\n+2' }] })
    expect(workflowItem(edit)).toMatchObject({ kind: 'file', detail: expect.stringContaining('a.ts') })
  })
  it('attributes historical actions to their recorded agent and cannot animate an ended session', () => {
    const events = workflowEvents(task, [stage], [tool('running')], undefined)
    expect(events.find((event) => event.item)).toMatchObject({ agent: 'claude', phase: 'recorded' })
    expect(events[0]).toMatchObject({ kind: 'stage', phase: 'ended' })
  })
  it('distinguishes an agent handoff from a same-agent session restart', () => {
    const events = workflowEvents(task, [stage, { ...stage, id: 'restart', startedAt: 10 }, { ...stage, id: 'handoff', agent: 'pi', startedAt: 20 }], [], undefined)
    expect(events.map((event) => event.kind)).toEqual(['stage', 'stage', 'handoff'])
  })
  it('does not follow stale native reads after a newer command completes', () => {
    const read = ChatItem.parse({ ...tool('running'), id: 'read', name: 'read', title: 'Running view_file' })
    const done = ChatItem.parse({ ...tool('done'), id: 'done', at: 3 })
    const events = workflowEvents(task, [{ ...stage, endedAt: null }], [read, done], liveConversation)
    expect(events.find((event) => event.item?.id === 'read')?.phase).toBe('recorded')
    const current = { key: 'current', laneId: 'task', taskId: 'task', stageId: 'stage', at: 4, agent: task.agent, kind: 'current' as const, title: 'running', detail: '', phase: 'running' as const }
    expect(activeWorkflowEvent([...events, current], 'task')).toBe(current)
  })
  it('follows each new foreground action and stops highlighting a call once the turn is idle', () => {
    const first = tool('running')
    const next = ChatItem.parse({ ...first, id: 'next', at: 3 })
    const live = workflowEvents(task, [{ ...stage, endedAt: null }], [first, next], liveConversation)
    expect(live.filter((event) => event.item && event.phase === 'running').map((event) => event.item?.id)).toEqual(['next'])
    const idle = workflowEvents(task, [{ ...stage, endedAt: null }], [first, next], { ...liveConversation, chat: { turn: 'idle' } })
    expect(idle.filter((event) => event.item && event.phase === 'running')).toEqual([])
  })
  it('keeps real background commands distinct from a superseded foreground read', () => {
    const background = ChatItem.parse({ ...tool('running'), background: true })
    const done = ChatItem.parse({ ...tool('done'), id: 'done', at: 3 })
    expect(workflowEvents(task, [{ ...stage, endedAt: null }], [background, done], liveConversation).find((event) => event.item?.id === background.id)?.phase).toBe('running')
  })
  it('does not turn internal state, thoughts or todo snapshots into worktree checkpoints', () => {
    expect(workflowItem(ChatItem.parse({ id: 'r', stageId: 'stage', revision: 0, at: 1, kind: 'reasoning', text: 'thinking', streaming: false }))).toBeNull()
    expect(workflowItem(ChatItem.parse({ id: 't', stageId: 'stage', revision: 0, at: 1, kind: 'todos', todos: [] }))).toBeNull()
  })
  it('follows the real running action in the current stage and falls back to its summary', () => {
    const events = workflowEvents(task, [{ ...stage, endedAt: null }], [tool('running')], { id: 'chat', title: 'A', titleLocked: true, agent: 'codex', workspacePath: '/w', managedWorkspace: false, projectPaths: [], sessionId: 's', chat: { turn: 'running' }, createdAt: 1, updatedAt: 1 })
    const current = { key: 'current', laneId: 'task', taskId: 'task', stageId: 'stage', at: 3, agent: task.agent, kind: 'current' as const, title: 'running', detail: '', phase: 'running' as const }
    expect(activeWorkflowEvent([...events, current], 'task')?.item?.id).toBe('tool')
    expect(activeWorkflowEvent([current], 'task')).toBe(current)
    expect(activeWorkflowEvent(events, null)).toBeNull()
  })
  it('keeps each lane of one task on its own current event', () => {
    const current = (laneId: string, at: number, agent: 'codex' | 'gemini') => ({ key: `${laneId}/current`, laneId, taskId: 'task', stageId: null, at, agent, kind: 'current' as const, title: 'running', detail: '', phase: 'running' as const })
    const codex = current('codex', 3, 'codex')
    const gemini = current('gemini', 4, 'gemini')
    expect(activeWorkflowEvent([codex, gemini], 'codex')).toBe(codex)
    expect(activeWorkflowEvent([codex, gemini], 'gemini')).toBe(gemini)
  })
  it('does not target streaming assistant messages as active workflow event', () => {
    const streamingMessage = ChatItem.parse({ id: 'msg', stageId: 'stage', revision: 0, at: 2, kind: 'assistant', text: 'thinking out loud', streaming: true })
    const events = workflowEvents(task, [{ ...stage, endedAt: null }], [streamingMessage], liveConversation)
    const current = { key: 'current', laneId: 'task', taskId: 'task', stageId: 'stage', at: 3, agent: task.agent, kind: 'current' as const, title: 'running', detail: '', phase: 'running' as const }
    expect(activeWorkflowEvent([...events, current], 'task')).toBe(current)
  })
})
