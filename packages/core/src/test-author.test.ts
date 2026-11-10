import { describe, expect, it } from 'vitest'
import type { Conversation, HiddenTestPlan, Task } from '@conclave/protocol'
import type { ConversationService } from './conversation-service'
import { TestAuthorService } from './test-author'

describe('TestAuthorService', () => {
  const task = {
    id: 'task', title: 'Login', details: 'Email and password', status: 'running', agent: 'claude',
    conversationId: '00000000-0000-4000-8000-000000000001',
    repos: [{ path: '/code', worktreePath: null, branch: null, startRef: null, start: null }], dependsOn: []
  } as unknown as Task
  const plan: HiddenTestPlan = { command: 'pnpm test hidden', files: [{ path: 'tests/login.test.ts', content: 'test' }], note: 'login', timeoutMs: 600_000 }
  const conversation = { id: '00000000-0000-4000-8000-000000000002' } as unknown as Conversation

  const chats = (text: string) => {
    const calls: { create: unknown[]; send: string[]; stopped: string[] } = { create: [], send: [], stopped: [] }
    const service = {
      create: async (...args: unknown[]) => { calls.create.push(args); return conversation },
      continue: async () => conversation,
      send: async (_id: string, message: string) => { calls.send.push(message) },
      chatPage: () => ({ items: [{ kind: 'turn', state: 'completed', id: 't', stageId: 's', revision: 1, at: 1 }] }),
      waitForTurn: async () => true,
      messages: () => [{ role: 'assistant', complete: true, text }],
      stop: async (id: string) => { calls.stopped.push(id) }
    } as unknown as Pick<ConversationService, 'create' | 'continue' | 'send' | 'chatPage' | 'messages' | 'stop' | 'waitForTurn'>
    return { service, calls }
  }

  it('runs a child read-only conversation and parses its plan', async () => {
    const { service, calls } = chats(JSON.stringify(plan))
    const author = new TestAuthorService(service)
    expect(await author.author(task)).toEqual(plan)
    expect(calls.send[0]).toContain('测试作者')
    expect(calls.send[0]).toContain('Email and password')
    expect(calls.stopped).toEqual([conversation.id])
    expect((calls.create[0] as unknown[])[3]).toMatchObject({ readOnly: true, parentId: task.conversationId })
  })

  it('keeps the selection it was given instead of taking every MCP server', async () => {
    const { service, calls } = chats(JSON.stringify(plan))
    await new TestAuthorService(service).author(task, ['docs'])
    expect((calls.create[0] as unknown[])[3]).toMatchObject({ mcpServers: ['docs'] })
  })

  it('returns null when the author answers with prose', async () => {
    const { service } = chats('I would write a test.')
    expect(await new TestAuthorService(service).author(task)).toBeNull()
  })

  it('returns null without a parent conversation', async () => {
    const { service, calls } = chats(JSON.stringify(plan))
    expect(await new TestAuthorService(service).author({ ...task, conversationId: null })).toBeNull()
    expect(calls.create).toHaveLength(0)
  })
})
