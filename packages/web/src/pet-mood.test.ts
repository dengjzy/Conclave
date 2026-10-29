import { describe, expect, it } from 'vitest'
import { Task, type Conversation } from '@conclave/protocol'
import type { Snapshot } from './attention'
import { petMood } from './pet-mood'

const chat = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id, title: id, titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [],
  managedWorkspace: true, sessionId: 'session', createdAt: 1, updatedAt: 1,
  lastExit: null, chat: { turn: 'idle' }, taskId: null, ...patch
})
const state = (conversations: Conversation[], unseen: string[] = []): Snapshot => ({
  tasks: {}, conversations: Object.fromEntries(conversations.map((c) => [c.id, c])),
  unseen: Object.fromEntries(unseen.map((id) => [id, true]))
})

describe('petMood', () => {
  it('points at input first, then failures, then running work', () => {
    const running = chat('running', { chat: { turn: 'running' } })
    const failed = chat('failed', { sessionId: null, lastExit: { code: 1, at: 2 } })
    const awaiting = chat('waiting', { chat: { turn: 'awaiting' } })
    expect(petMood(state([running, failed, awaiting]))).toMatchObject({ mood: 'waiting', attention: { target: { id: 'waiting' } } })
    expect(petMood(state([running, failed]))).toMatchObject({ mood: 'failed', attention: { target: { id: 'failed' } } })
    expect(petMood(state([running]))).toEqual({ mood: 'running', attention: null })
  })
  it('shows review only until finished work has been seen', () => {
    expect(petMood(state([chat('done')], ['done'])).mood).toBe('review')
    expect(petMood(state([chat('done')])).mood).toBe('idle')
  })
  it('shows running work ahead of a task left awaiting a reply, then restores its reminder', () => {
    const task = Task.parse({ id: 'old', title: 'Old task', details: '', status: 'running', repos: [], dependsOn: [], agent: 'claude', awaitingInput: true, createdAt: 1, updatedAt: 1 })
    const running = chat('running', { chat: { turn: 'running' } })
    const tasks = { [task.id]: task }
    expect(petMood({ ...state([running]), tasks })).toEqual({ mood: 'running', attention: null })
    expect(petMood({ ...state([chat('running')]), tasks })).toMatchObject({ mood: 'waiting', attention: { target: { id: task.id } } })
  })
  it('keeps an actual pending question ahead of running work', () => {
    const request = { requestId: 'question', kind: 'question' as const, tool: null, title: 'Continue?', decisions: [], open: 1, async: true }
    const waiting = chat('question', { chat: { turn: 'idle', request } })
    expect(petMood(state([chat('running', { chat: { turn: 'running' } }), waiting]))).toMatchObject({ mood: 'waiting', attention: { target: { id: waiting.id } } })
  })
  it('ignores archived chats and helper jobs', () => {
    const archived = chat('old', { archivedAt: 10, chat: { turn: 'running' } })
    const helper = chat('helper', { helperOf: 'parent', chat: { turn: 'running' } })
    expect(petMood(state([archived, helper], ['old', 'helper'])).mood).toBe('idle')
  })
})
