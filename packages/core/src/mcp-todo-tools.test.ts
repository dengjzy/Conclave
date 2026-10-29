import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRpcClient, rpcSchemas, type RpcConnection } from '@conclave/protocol'
import { createMcpHandler } from './mcp-server'
import { todoToolsOverCore } from './mcp-todo-tools'
import { TaskStore } from './task-store'
import { TodoStore } from './todo-store'

const Frame = z.object({ id: z.number(), method: z.string(), params: z.unknown() })

describe('to-do MCP tools', () => {
  let root: string
  let tasks: TaskStore
  let todos: TodoStore
  let rpc: RpcConnection
  let userTodos: boolean

  // A core that answers the to-do methods from a store of its own.
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-mcp-todos-'))
    const file = path.join(root, 'conclave.db')
    tasks = new TaskStore(file)
    todos = new TodoStore(file)
    userTodos = true
    const answer = (method: string, raw: unknown): unknown => {
      if (method === 'system.chatSettings') return { promptSuggestions: true, userTodos }
      if (method === 'todos.list') return todos.list(rpcSchemas['todos.list'].params.parse(raw).id)
      if (method === 'todos.add') {
        const { id, ...group } = rpcSchemas['todos.add'].params.parse(raw)
        return todos.add(id, group)
      }
      const { id, groupId, itemId, done } = rpcSchemas['todos.check'].params.parse(raw)
      return todos.check(id, groupId, itemId, done)
    }
    const client = createRpcClient((text) => {
      const frame = Frame.parse(JSON.parse(text))
      queueMicrotask(() => {
        try {
          client.receive(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: answer(frame.method, frame.params) }))
        } catch (error) {
          client.receive(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: String(error) } }))
        }
      })
    })
    rpc = { ...client, features: ['conversation-todos'], close: () => {}, closed: new Promise(() => {}) }
  })

  afterEach(() => {
    todos.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  const conversationId = '00000000-0000-4000-8000-000000000001'
  const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join('')

  it('lets the agent write a group down, read it back with ids, and tick it off', async () => {
    const withCore = async <T>(action: (connection: RpcConnection) => Promise<T>) => action(rpc)
    const tools = todoToolsOverCore(withCore, conversationId)
    const handler = createMcpHandler({ preview: async () => {}, planOnly: true, todo: tools })
    const listed = JSON.stringify(await handler(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })))
    expect(listed).toContain('user_todo_add')
    expect(listed).toContain('user_todo_check')

    const tool = (name: string) => tools.find((each) => each.spec.name === name)!
    const added = await tool('user_todo_add').run({ title: '真机验证', note: '上线前', items: ['加载已解压', { text: '重载后自动恢复', owner: 'agent' }] })
    expect(added.isError).toBe(false)
    expect(text(added)).toContain('已记成待办')
    const [group] = todos.list(conversationId)
    expect(group).toMatchObject({ title: '真机验证', note: '上线前', items: [{ text: '加载已解压', owner: 'user' }, { text: '重载后自动恢复', owner: 'agent' }] })

    expect(text(await tool('user_todo_list').run({}))).toContain(`组 id ${group!.id}`)
    const checked = await tool('user_todo_check').run({ group: group!.id, item: group!.items[0]!.id })
    expect(text(checked)).toContain('1 项未完成')
    expect((await tool('user_todo_add').run({ title: '', items: [] })).isError).toBe(true)
    expect((await tool('user_todo_check').run({ group: 'nope' })).isError).toBe(true)
  })

  it('refuses every call once the user turns to-dos off, though the agent still holds the tools', async () => {
    const tools = todoToolsOverCore(async (action) => action(rpc), conversationId)
    const tool = (name: string) => tools.find((each) => each.spec.name === name)!
    userTodos = false
    const refused = await tool('user_todo_add').run({ title: '真机验证', items: ['加载已解压'] })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('关闭了待办')
    expect((await tool('user_todo_list').run({})).isError).toBe(true)
    expect(todos.list(conversationId)).toEqual([])
    userTodos = true
    expect((await tool('user_todo_add').run({ title: '真机验证', items: ['加载已解压'] })).isError).toBe(false)
  })
})
