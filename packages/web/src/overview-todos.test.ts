import { describe, expect, it } from 'vitest'
import { Conversation, Task, type TodoGroup } from '@conclave/protocol'
import { overviewTodos, STALE_TODO_MS } from './overview-todos'

const now = new Date(2026, 9, 15, 12).getTime()
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const chat = (n: number, patch: object = {}) => Conversation.parse({
  id: id(n), title: `会话 ${n}`, titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [], managedWorkspace: false,
  sessionId: null, createdAt: now, updatedAt: now, ...patch
})
const group = (title: string, items: Array<[string, 'user' | 'agent', boolean?]>, updatedAt = now, note: string | null = null): TodoGroup => ({
  id: title, title, note, createdAt: updatedAt, updatedAt,
  items: items.map(([text, owner, done = false]) => ({ id: text, text, owner, done, createdAt: updatedAt, doneAt: done ? updatedAt : null }))
})

describe('overview to-dos', () => {
  it('gathers open items per conversation, the user\'s first, and lists conversations with some for the user first', () => {
    const conversations = { [id(1)]: chat(1), [id(2)]: chat(2) }
    const result = overviewTodos({
      [id(1)]: [group('可选', [['整理文档', 'agent']], now - 1000)],
      [id(2)]: [group('上线前', [['补测试', 'agent'], ['通知运营', 'user'], ['改版本号', 'user', true]], now - 5000, '周五前'), group('完成了', [['删文件', 'user', true]])]
    }, conversations, {}, now)
    expect(result.entries.map((entry) => [entry.title, entry.lines.map((line) => line.item.text)])).toEqual([
      ['会话 2', ['通知运营', '补测试']],
      ['会话 1', ['整理文档']]
    ])
    expect(result.entries[0]).toMatchObject({ mine: 1, agents: 1, updatedAt: now - 5000, stale: false })
    expect(result.entries[0]?.lines[0]).toMatchObject({ group: '上线前', note: '周五前' })
    expect(result).toMatchObject({ mine: 1, agents: 2, archived: 0 })
  })

  it('names a task chat after its task, and leaves out parts of other conversations and finished lists', () => {
    const task = Task.parse({ id: 'task', title: '支付改版', details: '', status: 'running', repos: [], dependsOn: [], agent: 'codex', createdAt: now, updatedAt: now })
    const conversations = {
      [id(1)]: chat(1, { taskId: 'task' }), [id(2)]: chat(2, { helperOf: id(1) }), [id(3)]: chat(3, { discussionId: id(9) }),
      [id(4)]: chat(4, { squadRunId: id(8) }), [id(5)]: chat(5, { routineId: id(7) }), [id(6)]: chat(6)
    }
    const open = [group('事项', [['一件事', 'user']])]
    const result = overviewTodos({ [id(1)]: open, [id(2)]: open, [id(3)]: open, [id(4)]: open, [id(5)]: open, [id(6)]: [group('完', [['x', 'user', true]])], [id(10)]: open }, conversations, { task }, now)
    expect(result.entries.map((entry) => [entry.title, entry.taskId])).toEqual([['支付改版', 'task']])
  })

  it('hides an archived conversation\'s to-dos unless asked, counting them apart, and marks a list left alone for a week', () => {
    const conversations = { [id(1)]: chat(1, { archivedAt: now }), [id(2)]: chat(2) }
    const todos = { [id(1)]: [group('旧', [['a', 'user'], ['b', 'agent']])], [id(2)]: [group('久', [['c', 'user']], now - STALE_TODO_MS - 1)] }
    const hidden = overviewTodos(todos, conversations, {}, now)
    expect(hidden.entries.map((entry) => [entry.conversationId, entry.stale])).toEqual([[id(2), true]])
    expect(hidden).toMatchObject({ mine: 1, agents: 0, archived: 2 })
    expect(overviewTodos(todos, conversations, {}, now, true).entries.map((entry) => entry.conversationId)).toEqual([id(1), id(2)])
  })

  it('orders by the newest to-do added, so checking one off moves nothing, and keeps lines checked here in place', () => {
    const conversations = { [id(1)]: chat(1), [id(2)]: chat(2) }
    const before = {
      [id(1)]: [group('早', [['a', 'user'], ['b', 'user']], now - 5000)],
      [id(2)]: [group('晚', [['c', 'user']], now - 1000)]
    }
    expect(overviewTodos(before, conversations, {}, now).entries.map((entry) => entry.conversationId)).toEqual([id(2), id(1)])
    // Checking 'a' and then 'b' off bumps the list's updatedAt, as core does.
    const checked = (done: string[]) => ({ ...before, [id(1)]: [{ ...group('早', [['a', 'user', done.includes('a')], ['b', 'user', done.includes('b')]], now - 5000), updatedAt: now }] })
    const one = overviewTodos(checked(['a']), conversations, {}, now, false, new Set(['a']))
    expect(one.entries.map((entry) => entry.conversationId)).toEqual([id(2), id(1)])
    expect(one.entries[1]?.lines.map((line) => [line.item.text, line.item.done])).toEqual([['a', true], ['b', false]])
    expect(one).toMatchObject({ mine: 2 })
    const all = overviewTodos(checked(['a', 'b']), conversations, {}, now, false, new Set(['a', 'b']))
    expect(all.entries.map((entry) => [entry.conversationId, entry.mine])).toEqual([[id(2), 1], [id(1), 0]])
    expect(overviewTodos(checked(['a', 'b']), conversations, {}, now).entries.map((entry) => entry.conversationId)).toEqual([id(2)])
  })
})
