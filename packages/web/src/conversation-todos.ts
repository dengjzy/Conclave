import { useEffect } from 'react'
import { create } from 'zustand'
import { openTodoCount, type TodoGroup } from '@conclave/protocol'
import { perform, useCore } from './core-store'

// Each conversation's to-dos as core last told: read once a conversation's panel wants them, then
// kept current by todos.changed.
const useTodoStore = create<Record<string, readonly TodoGroup[]>>()(() => ({}))

const NONE: readonly TodoGroup[] = []

export function receiveTodos(conversationId: string, groups: readonly TodoGroup[]): void {
  useTodoStore.setState({ [conversationId]: groups })
}

// Where core keeps to-dos and the user has not turned them off (ChatSettings.userTodos).
export function useTodosShown(): boolean {
  return useCore((s) => (s.rpc?.features.includes('conversation-todos') ?? false) && s.chatSettings?.userTodos !== false)
}

// Every conversation's to-dos known so far: those with something left, all read at connect
// (todos.open), and any other a panel has read since.
export function useAllTodos(): Readonly<Record<string, readonly TodoGroup[]>> {
  return useTodoStore((s) => s)
}

export function useTodoOverviewShown(): boolean {
  return useCore((s) => (s.rpc?.features.includes('todo-overview') ?? false) && s.chatSettings?.userTodos !== false)
}

// How many of a conversation's to-dos are not done, for a badge where the panel is closed.
export function useOpenTodoCount(conversationId: string | null): number {
  return openTodoCount(useConversationTodos(conversationId))
}

// The conversation's to-dos, read from core the first time they are wanted; empty until then and
// on a core that keeps none.
export function useConversationTodos(conversationId: string | null): readonly TodoGroup[] {
  const shown = useTodosShown()
  const known = useTodoStore((s) => (conversationId ? s[conversationId] : undefined))
  useEffect(() => {
    if (!shown || !conversationId || known !== undefined) return
    void perform((rpc) => rpc.call('todos.list', { id: conversationId })).then((groups) => {
      if (groups) receiveTodos(conversationId, groups)
    })
  }, [shown, conversationId, known])
  return known ?? NONE
}
