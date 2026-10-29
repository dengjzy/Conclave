import { createContext, useCallback, useContext } from 'react'
import { create } from 'zustand'

// What the user opened in each chat, by key within it: a turn's work, a run of calls, a thought, a
// long message. Kept while the window is open, so a chat they come back to is as they left it.
const useOpened = create<Record<string, Readonly<Record<string, true>>>>()(() => ({}))

// The chat whose openings a component reads and sets.
export const ChatDisclosureScope = createContext('')
// Search reveals content without changing the user's saved openings.
export const ChatFindExpansion = createContext(false)

export function setOpened(conversationId: string, key: string, open: boolean): void {
  useOpened.setState((s) => {
    const { [key]: _was, ...rest } = s[conversationId] ?? {}
    return { [conversationId]: open ? { ...rest, [key]: true } : rest }
  })
}

export function useDisclosure(key: string): [boolean, (open: boolean) => void] {
  const id = useContext(ChatDisclosureScope)
  const open = useOpened((s) => Boolean(s[id]?.[key]))
  const searching = useContext(ChatFindExpansion)
  const set = useCallback((next: boolean) => { if (!searching) setOpened(id, key, next) }, [id, key, searching])
  return [open || searching, set]
}

// Which one of `keys` is open, for a group that opens one at a time; opening one closes the rest.
export function useChosen(keys: readonly string[]): [string | null, (key: string | null) => void] {
  const id = useContext(ChatDisclosureScope)
  const searching = useContext(ChatFindExpansion)
  const chosen = useOpened((s) => keys.find((key) => s[id]?.[key]) ?? null)
  const choose = useCallback((next: string | null) => {
    if (searching) return
    for (const key of keys) setOpened(id, key, key === next)
  }, [id, keys, searching])
  return [chosen, choose]
}
