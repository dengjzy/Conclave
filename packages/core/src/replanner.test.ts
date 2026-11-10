import { describe, expect, it } from 'vitest'
import type { Conversation, Replan, Task } from '@conclave/protocol'
import type { ConversationService } from './conversation-service'
import { ReplannerService } from './replanner'

describe('ReplannerService', () => {
  const task = {
    id: 'task', title: 'Login', details: 'Email and password', status: 'running', agent: 'claude',
    conversationId: '00000000-0000-4000-8000-000000000001',
    repos: [{ path: '/code', worktreePath: '/wt', branch: null, startRef: null, start: null }], dependsOn: []
  } as unknown as Task
  const plan: Replan = { diagnosis: 'the route is missing', instruction: 'add the route first', steps: [] }
  const conversation = { id: '00000000-0000-4000-8000-000000000002' } as unknown as Conversation

  const chats = (text: string) => {
    const sent: string[] = []
    const created: unknown[][] = []
    const service = {
      create: async (...args: unknown[]) => { created.push(args); return conversation },
      continue: async () => conversation,
      send: async (_id: string, message: string) => { sent.push(message) },
      chatPage: () => ({ items: [{ kind: 'turn', state: 'completed', id: 't', stageId: 's', revision: 1, at: 1 }] }),
      waitForTurn: async () => true,
      messages: () => [{ role: 'assistant', complete: true, text }],
      stop: async () => {}
    } as unknown as Pick<ConversationService, 'create' | 'continue' | 'send' | 'chatPage' | 'messages' | 'stop' | 'waitForTurn'>
    return { service, sent, created }
  }

  it('asks for a diagnosis and a different instruction', async () => {
    const { service, sent, created } = chats(JSON.stringify(plan))
    expect(await new ReplannerService(service).propose(task, '#1 claude · fail · test', 'AssertionError')).toEqual(plan)
    expect(sent[0]).toContain('重新规划者')
    expect(sent[0]).toContain('#1 claude')
    expect(sent[0]).toContain('AssertionError')
    expect((created[0] as unknown[])[1]).toEqual(['/wt'])
  })

  it('keeps the selection it was given instead of taking every MCP server', async () => {
    const { service, created } = chats(JSON.stringify(plan))
    await new ReplannerService(service).propose(task, '', 'boom', ['docs'])
    expect((created[0] as unknown[])[3]).toMatchObject({ mcpServers: ['docs'] })
  })

  it('returns null when the planner answers with prose', async () => {
    const { service } = chats('try again')
    expect(await new ReplannerService(service).propose(task, '', 'boom')).toBeNull()
  })
})
