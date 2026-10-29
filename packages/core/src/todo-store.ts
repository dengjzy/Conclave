import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { MAX_TODO_GROUPS, MAX_TODO_ITEMS, TodoList, todoGroupDone, type RpcParsedParams, type TodoGroup } from '@conclave/protocol'
import { Rejection } from './rejection'

type AddParams = Omit<RpcParsedParams<'todos.add'>, 'id'>

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// Each conversation's to-dos, as one list of groups. Every change goes through `changed`, which
// tells the clients; a conversation that goes takes its list with it (drop).
export class TodoStore {
  private readonly db: DatabaseSync
  constructor(file: string, private readonly changed: (conversationId: string, groups: TodoGroup[]) => void = () => {}, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  close(): void {
    this.db.close()
  }

  list(conversationId: string): TodoGroup[] {
    const row = this.db.prepare('SELECT groups FROM conversation_todos WHERE conversation_id = ?').get(conversationId)
    return row ? TodoList.parse(JSON.parse(String(row.groups))) : []
  }

  // Every conversation with something left to do, with its whole list (as list gives it, so a
  // client can keep it as that conversation's): what the overview gathers.
  open(): { conversationId: string; groups: TodoGroup[] }[] {
    return this.db.prepare('SELECT conversation_id AS id, groups FROM conversation_todos').all().flatMap((row) => {
      const groups = TodoList.parse(JSON.parse(String(row.groups)))
      return groups.some((group) => group.items.some((item) => !item.done)) ? [{ conversationId: String(row.id), groups }] : []
    })
  }

  // A new group, or more items in the open group of that title (or the one named): what a later
  // reply adds to a list it wrote before goes with it, and an item already there is not doubled.
  add(conversationId: string, { title, note, groupId, items }: AddParams): TodoGroup[] {
    const groups = this.list(conversationId)
    const at = this.now()
    const target = groupId !== undefined
      ? groups.find((group) => group.id === groupId)
      : groups.find((group) => same(group.title, title) && !todoGroupDone(group))
    if (groupId !== undefined && !target) throw new Rejection('todo-not-found', `no to-do group ${groupId}`)
    const fresh = (existing: readonly { text: string }[]) =>
      items.filter((item, index) => !existing.some((each) => same(each.text, item.text)) && items.findIndex((other) => same(other.text, item.text)) === index)
        .map((item) => ({ id: randomUUID(), text: item.text, owner: item.owner, done: false, createdAt: at, doneAt: null }))
    if (target) {
      const added = fresh(target.items)
      if (target.items.length + added.length > MAX_TODO_ITEMS) throw new Rejection('todo-full', `a group holds at most ${MAX_TODO_ITEMS} items`)
      return this.save(conversationId, groups.map((group) => group === target
        ? { ...group, note: note === undefined ? group.note : note, items: [...group.items, ...added], updatedAt: at }
        : group))
    }
    if (groups.length >= MAX_TODO_GROUPS) throw new Rejection('todo-full', `a conversation holds at most ${MAX_TODO_GROUPS} groups`)
    return this.save(conversationId, [...groups, { id: randomUUID(), title, note: note ?? null, items: fresh([]), createdAt: at, updatedAt: at }])
  }

  // One item, or the whole group when none is named.
  check(conversationId: string, groupId: string, itemId: string | undefined, done: boolean): TodoGroup[] {
    const at = this.now()
    return this.change(conversationId, groupId, (group) => ({
      ...group,
      items: group.items.map((item) => itemId === undefined || item.id === itemId
        ? { ...item, done, doneAt: done ? (item.done ? item.doneAt : at) : null }
        : item),
      updatedAt: at
    }), itemId)
  }

  // An item's text, or the group's title when no item is named.
  edit(conversationId: string, groupId: string, itemId: string | undefined, text: string): TodoGroup[] {
    return this.change(conversationId, groupId, (group) => itemId === undefined
      ? { ...group, title: text.slice(0, 120), updatedAt: this.now() }
      : { ...group, items: group.items.map((item) => (item.id === itemId ? { ...item, text } : item)), updatedAt: this.now() }, itemId)
  }

  // An item, or the whole group when none is named; a group left empty goes too.
  remove(conversationId: string, groupId: string, itemId?: string): TodoGroup[] {
    const groups = this.list(conversationId)
    if (!groups.some((group) => group.id === groupId)) throw new Rejection('todo-not-found', `no to-do group ${groupId}`)
    if (itemId !== undefined && !groups.some((group) => group.id === groupId && group.items.some((item) => item.id === itemId))) {
      throw new Rejection('todo-not-found', `no to-do item ${itemId}`)
    }
    return this.save(conversationId, groups.flatMap((group) => {
      if (group.id !== groupId) return [group]
      if (itemId === undefined) return []
      const items = group.items.filter((item) => item.id !== itemId)
      return items.length > 0 ? [{ ...group, items, updatedAt: this.now() }] : []
    }))
  }

  // The conversation is gone; so are its to-dos. Nothing is said, as nothing shows them any more.
  drop(conversationId: string): void {
    this.db.prepare('DELETE FROM conversation_todos WHERE conversation_id = ?').run(conversationId)
  }

  private change(conversationId: string, groupId: string, update: (group: TodoGroup) => TodoGroup, itemId?: string): TodoGroup[] {
    const groups = this.list(conversationId)
    const group = groups.find((each) => each.id === groupId)
    if (!group) throw new Rejection('todo-not-found', `no to-do group ${groupId}`)
    if (itemId !== undefined && !group.items.some((item) => item.id === itemId)) throw new Rejection('todo-not-found', `no to-do item ${itemId}`)
    return this.save(conversationId, groups.map((each) => (each === group ? update(each) : each)))
  }

  private save(conversationId: string, groups: TodoGroup[]): TodoGroup[] {
    const parsed = TodoList.parse(groups)
    if (parsed.length === 0) this.drop(conversationId)
    else this.db.prepare('INSERT INTO conversation_todos (conversation_id, groups) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET groups = excluded.groups')
      .run(conversationId, JSON.stringify(parsed))
    this.changed(conversationId, parsed)
    return parsed
  }
}
