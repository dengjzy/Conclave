import { describe, expect, it } from 'vitest'
import { SquadRun, Task, type Conversation } from '@conclave/protocol'
import { followWorkflowLane } from './workflow-progress'
import { squadWorkflowLanes, workflowLanes } from './workflow-lanes'

const leaderId = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'
const task = Task.parse({
  id: 'task', title: 'LAN chat', details: '', status: 'running', repos: [], dependsOn: [], agent: 'codex',
  squadId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444', createdAt: 1, updatedAt: 200
})
const run = SquadRun.parse({
  id: '55555555-5555-4555-8555-555555555555', taskId: task.id, leaderConversationId: task.conversationId,
  state: 'running', permissionMode: 'ask', allowBypass: false, summary: null, createdAt: 1, updatedAt: 300,
  squad: {
    id: '33333333-3333-4333-8333-333333333333', name: 'Squad', description: '', instructions: '', leaderId, archivedAt: null, createdAt: 1, updatedAt: 1,
    members: [
      { id: leaderId, name: 'Lead', agent: 'codex', model: null, effort: null, role: '', capability: 'readOnly' },
      { id: memberId, name: 'Tester', agent: 'pi', model: null, effort: null, role: '', capability: 'develop' }
    ]
  },
  works: [
    { id: '66666666-6666-4666-8666-666666666666', memberId, conversationId: '77777777-7777-4777-8777-777777777777', instruction: 'Run the tests', capability: 'develop', state: 'running', result: null, error: null, delivered: false, createdAt: 10, updatedAt: 300 }
  ]
})
const conversation = (id: string, agent: Conversation['agent'], turn: 'idle' | 'running' | 'awaiting', updatedAt: number): Conversation => ({
  id, title: id, titleLocked: true, agent, workspacePath: '/w', managedWorkspace: false, projectPaths: [], sessionId: `s-${id}`, chat: { turn }, createdAt: 1, updatedAt
})

describe('workflow lanes', () => {
  it('focuses whichever agent is working, then moves on when another works', () => {
    const lane = (id: string, agent: 'codex' | 'gemini', updatedAt: number) => Task.parse({ id, title: id, details: '', status: 'running', repos: [], dependsOn: [], agent, conversationId: `conv-${id}`, createdAt: 1, updatedAt })
    const conversations = {
      'conv-codex': conversation('conv-codex', 'codex', 'running', 100),
      'conv-gemini': conversation('conv-gemini', 'gemini', 'running', 3_000)
    }
    const lanes = workflowLanes([lane('codex', 'codex', 100), lane('gemini', 'gemini', 3_000)], conversations, [], {})
    expect(followWorkflowLane(lanes, 'codex')).toBe('gemini')
    const codexOnly = workflowLanes([lane('codex', 'codex', 5_000), lane('gemini', 'gemini', 3_000)], {
      ...conversations,
      'conv-gemini': conversation('conv-gemini', 'gemini', 'idle', 3_000)
    }, [], {})
    expect(followWorkflowLane(codexOnly, 'gemini')).toBe('codex')
  })
  it('gives each squad member its own lane and follows the member doing the work', () => {
    const lanes = squadWorkflowLanes(task, run, {
      [task.conversationId!]: conversation(task.conversationId!, 'codex', 'idle', 100),
      '77777777-7777-4777-8777-777777777777': conversation('77777777-7777-4777-8777-777777777777', 'pi', 'running', 300)
    })
    expect(lanes.map((lane) => ({ id: lane.id, title: lane.title, agent: lane.agent, phase: lane.phase }))).toEqual([
      { id: leaderId, title: 'Lead', agent: 'codex', phase: 'idle' },
      { id: memberId, title: 'Tester', agent: 'pi', phase: 'running' }
    ])
    expect(followWorkflowLane(lanes, leaderId)).toBe(memberId)
  })
  it('marks a member awaiting the user as the lane to focus', () => {
    const lanes = squadWorkflowLanes(task, run, {
      [task.conversationId!]: conversation(task.conversationId!, 'codex', 'running', 100),
      '77777777-7777-4777-8777-777777777777': conversation('77777777-7777-4777-8777-777777777777', 'pi', 'awaiting', 300)
    })
    expect(lanes.find((lane) => lane.id === memberId)?.phase).toBe('awaiting')
    expect(followWorkflowLane(lanes, leaderId)).toBe(memberId)
  })
  it('shows a finished run in the task state rather than as live member work', () => {
    const lanes = squadWorkflowLanes({ ...task, status: 'review' }, { ...run, state: 'review' }, {})
    expect(lanes.map((lane) => lane.phase)).toEqual(['review', 'review'])
  })
})
