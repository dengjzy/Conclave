import { describe, expect, it } from 'vitest'
import { Task, type Conversation, type ConversationStage } from '@conclave/protocol'
import { followWorkflowLane, stagePhase, workflowPhase } from './workflow-progress'

const task = Task.parse({ id: 'a', title: 'A', details: '', status: 'running', repos: [], dependsOn: [], agent: 'codex', conversationId: 'c', createdAt: 1, updatedAt: 1 })
const conversation: Conversation = { id: 'c', title: 'A', titleLocked: true, agent: 'codex', workspacePath: '/w', managedWorkspace: false, projectPaths: ['/w'], sessionId: 's', chat: { turn: 'running' }, createdAt: 1, updatedAt: 1 }
const stage: ConversationStage = { id: 'stage', conversationId: 'c', agent: 'codex', providerSessionId: null, sessionId: 's', receivedSequence: 0, startedAt: 1, endedAt: null, exitCode: null }

describe('workflow execution flow', () => {
  it('does not animate an idle, accepted or failed task as if it were running', () => {
    expect(workflowPhase(task, conversation, false, null)).toBe('idle')
    expect(workflowPhase(task, conversation, false, { state: 'running', workers: [], detail: 'test' })).toBe('running')
    expect(workflowPhase({ ...task, status: 'done' }, conversation, true, { state: 'running', workers: [], detail: null })).toBe('done')
    expect(workflowPhase(task, { ...conversation, sessionId: null, lastExit: { code: 1, at: 2 } }, false, null)).toBe('failed')
    expect(workflowPhase({ ...task, status: 'pending' }, { ...conversation, starting: true }, false, null)).toBe('starting')
  })
  it('distinguishes a recorded stage from live activity and never treats exit 0 as task acceptance', () => {
    expect(stagePhase(stage, conversation)).toBe('running')
    expect(stagePhase(stage, { ...conversation, chat: { turn: 'awaiting' } })).toBe('awaiting')
    expect(stagePhase(stage, { ...conversation, sessionId: 'new-stage-session' })).toBe('recorded')
    expect(stagePhase({ ...stage, endedAt: 2, exitCode: 0 }, conversation)).toBe('ended')
    expect(stagePhase({ ...stage, endedAt: 2, exitCode: 1 }, conversation)).toBe('failed')
    expect(stagePhase(stage, { ...conversation, chat: { turn: 'idle' } })).toBe('idle')
  })
  it('moves to the lane that most recently became active and keeps it through small bursts', () => {
    const lanes = [{ id: 'a', phase: 'running' as const, updatedAt: 1_000 }, { id: 'b', phase: 'running' as const, updatedAt: 3_000 }]
    expect(followWorkflowLane(lanes, 'a')).toBe('b')
    expect(followWorkflowLane(lanes, null)).toBe('b')
    expect(followWorkflowLane([{ ...lanes[0]!, updatedAt: 2_800 }, lanes[1]!], 'a')).toBe('a')
    expect(followWorkflowLane([{ id: 'a', phase: 'review' }, lanes[1]!], 'a')).toBe('b')
    expect(followWorkflowLane([{ id: 'a', phase: 'done' }], 'a')).toBeNull()
  })
  it('brings a user request into view and releases a lane hidden by filters', () => {
    expect(followWorkflowLane([{ id: 'a', phase: 'running' }, { id: 'b', phase: 'awaiting' }], 'a')).toBe('b')
    expect(followWorkflowLane([{ id: 'b', phase: 'starting' }], 'a')).toBe('b')
    expect(followWorkflowLane([{ id: 'a', phase: 'awaiting', updatedAt: 1 }, { id: 'b', phase: 'awaiting', updatedAt: 2 }], 'a')).toBe('b')
  })
})
