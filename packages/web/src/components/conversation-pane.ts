import { createContext, useContext } from 'react'

// The column of a split a conversation shows in: which of the two, whether it is the one in front,
// and how to bring it there. Outside a split there is none, and everything acts as it always has.
export type ConversationPane = { index: 0 | 1; active: boolean; focus: () => void }

export const ConversationPaneContext = createContext<ConversationPane | null>(null)

export function useConversationPane(): ConversationPane | null {
  return useContext(ConversationPaneContext)
}

// Shortcuts that act on "the chat" belong to the one in front; with no split, to the only one.
export function paneOwnsShortcuts(pane: ConversationPane | null): boolean {
  return pane === null || pane.active
}
