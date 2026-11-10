import { describe, expect, it } from 'vitest'
import type { Conversation, Task } from '@conclave/protocol'
import { PlannerService } from './planner-service'

describe('PlannerService', () => {
  const task = {
    id: 't', title: 'Login', details: 'Add a login route', agent: 'codex', conversationId: null,
    repos: [{ path: '/code', worktreePath: '/wt', branch: null, startRef: null, start: null }], dependsOn: []
  } as unknown as Task
  const conversation = { id: '00000000-0000-4000-8000-000000000002' } as unknown as Conversation

  const chats = (text: string) => {
    const created: unknown[][] = []
    const sent: string[] = []
    const service = {
      create: async (...args: unknown[]) => { created.push(args); return conversation },
      continue: async () => {},
      send: async (_id: string, content: string) => { sent.push(content) },
      chatPage: () => ({ items: [] }),
      messages: () => [{ role: 'assistant', complete: true, text }],
      stop: async () => {},
      waitForTurn: async () => true
    }
    return { service, created, sent }
  }

  it('reads a plan from the planner child and runs read-only in the worktree', async () => {
    const { service, created } = chats(JSON.stringify({ steps: [{ title: 'route', instruction: 'add the route' }] }))
    const plan = await new PlannerService(service as never).plan(task)
    expect(plan).toEqual([{ title: 'route', instruction: 'add the route', agent: null }])
    const options = created[0]?.[3] as { readOnly?: boolean; mcpServers?: unknown }
    expect(options.readOnly).toBe(true)
    expect(created[0]?.[1]).toEqual(['/wt'])
  })

  it('offers the agents it may split the work between and keeps one it can start', async () => {
    const { service, created, sent } = chats(JSON.stringify({
      steps: [
        { title: 'api', instruction: 'do the api', agent: 'pi' },
        { title: 'ui', instruction: 'do the ui', agent: 'gemini' }
      ]
    }))
    const plan = await new PlannerService(service as never).plan(task, ['pi'])
    // codex is the task's own agent; gemini was not offered, so that step falls back.
    expect(plan?.map((step) => step.agent)).toEqual(['pi', null])
    expect(sent[0]).toContain('pi（')
    expect(sent[0]).not.toContain('gemini')
    const options = created[0]?.[3] as { readOnly?: boolean }
    expect(options.readOnly).toBe(true)
  })

  it('returns null when the planner gives no plan', async () => {
    const { service } = chats('I will think about it')
    expect(await new PlannerService(service as never).plan(task)).toBeNull()
  })
})
