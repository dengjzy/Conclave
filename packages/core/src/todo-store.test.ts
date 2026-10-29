import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TodoGroup } from '@conclave/protocol'
import { TaskStore } from './task-store'
import { TodoStore } from './todo-store'

describe('TodoStore', () => {
  let root: string
  let tasks: TaskStore
  let todos: TodoStore
  let told: Array<{ conversationId: string; groups: TodoGroup[] }>
  let clock: number

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-todos-'))
    const file = path.join(root, 'conclave.db')
    tasks = new TaskStore(file)
    told = []
    clock = 100
    todos = new TodoStore(file, (conversationId, groups) => told.push({ conversationId, groups }), () => clock)
  })

  afterEach(() => {
    todos.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  const texts = (groups: TodoGroup[]) => groups.map((group) => [group.title, group.items.map((item) => item.text)])

  it('groups items under a heading, adding a later list to the open group of that title without doubling', () => {
    todos.add('c1', { title: '真机验证', note: '上线前', items: [{ text: '加载已解压', owner: 'user' }, { text: '加载已解压', owner: 'user' }] })
    const groups = todos.add('c1', { title: ' 真机验证 ', items: [{ text: '加载已解压', owner: 'user' }, { text: '重载后自动恢复', owner: 'agent' }] })
    expect(texts(groups)).toEqual([['真机验证', ['加载已解压', '重载后自动恢复']]])
    expect(groups[0]).toMatchObject({ note: '上线前', items: [{ owner: 'user', done: false }, { owner: 'agent', done: false }] })
    expect(todos.list('c2')).toEqual([])
    // Restarted, it still holds them.
    todos.close()
    todos = new TodoStore(path.join(root, 'conclave.db'))
    expect(texts(todos.list('c1'))).toEqual([['真机验证', ['加载已解压', '重载后自动恢复']]])
  })

  it('checks an item or a whole group, and a finished group takes no more under its title', () => {
    const [group] = todos.add('c1', { title: '发布顺序', items: [{ text: 'CS 插件', owner: 'user' }, { text: 'menu-service', owner: 'user' }] })
    clock = 200
    let groups = todos.check('c1', group!.id, group!.items[0]!.id, true)
    expect(groups[0]?.items.map((item) => [item.done, item.doneAt])).toEqual([[true, 200], [false, null]])
    clock = 300
    groups = todos.check('c1', group!.id, undefined, true)
    // The one done before keeps when it was done.
    expect(groups[0]?.items.map((item) => item.doneAt)).toEqual([200, 300])
    groups = todos.add('c1', { title: '发布顺序', items: [{ text: 'magi', owner: 'user' }] })
    expect(texts(groups)).toEqual([['发布顺序', ['CS 插件', 'menu-service']], ['发布顺序', ['magi']]])
    expect(todos.check('c1', group!.id, undefined, false)[0]?.items.every((item) => !item.done && item.doneAt === null)).toBe(true)
  })

  it('edits and removes, a group going with its last item, and refuses what is not there', () => {
    const [group] = todos.add('c1', { title: '配置', items: [{ text: 'GUIDE_URL', owner: 'user' }, { text: 'DEV 开关', owner: 'agent' }] })
    const [first, second] = group!.items
    expect(texts(todos.edit('c1', group!.id, first!.id, 'VITE_GUIDE_URL'))).toEqual([['配置', ['VITE_GUIDE_URL', 'DEV 开关']]])
    expect(todos.edit('c1', group!.id, undefined, '可选配置')[0]?.title).toBe('可选配置')
    expect(texts(todos.remove('c1', group!.id, first!.id))).toEqual([['可选配置', ['DEV 开关']]])
    expect(todos.remove('c1', group!.id, second!.id)).toEqual([])
    expect(() => todos.check('c1', group!.id, undefined, true)).toThrow(expect.objectContaining({ reason: 'todo-not-found' }))
    expect(() => todos.add('c1', { title: 'x', groupId: 'nope', items: [{ text: 'y', owner: 'user' }] })).toThrow(expect.objectContaining({ reason: 'todo-not-found' }))
  })

  it('tells of every change, and forgets a conversation that is gone', () => {
    todos.add('c1', { title: '对齐', items: [{ text: 'GAP-09', owner: 'user' }] })
    expect(told.map((each) => [each.conversationId, texts(each.groups)])).toEqual([['c1', [['对齐', ['GAP-09']]]]])
    todos.drop('c1')
    expect(todos.list('c1')).toEqual([])
  })

  it('gathers the lists of conversations with something left to do, whole', () => {
    const first = todos.add('a', { title: '上线前', note: null, items: [{ text: '通知运营', owner: 'user' }, { text: '补测试', owner: 'agent' }] })
    const done = todos.add('a', { title: '已完成', note: null, items: [{ text: '改版本号', owner: 'agent' }] })
    todos.check('a', done[1]!.id, undefined, true)
    todos.check('a', first[0]!.id, first[0]!.items[0]!.id, true)
    const finished = todos.add('b', { title: '全做完了', note: null, items: [{ text: '删文件', owner: 'user' }] })
    todos.check('b', finished[0]!.id, undefined, true)
    todos.add('c', { title: '可选', note: '有空再做', items: [{ text: '整理文档', owner: 'user' }] })
    expect(todos.open().map(({ conversationId, groups }) => [conversationId, texts(groups)])).toEqual([
      ['a', [['上线前', ['通知运营', '补测试']], ['已完成', ['改版本号']]]],
      ['c', [['可选', ['整理文档']]]]
    ])
  })
})
