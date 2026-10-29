// A conversation dragged out of the list, to open beside the one in view. Which one it is can be
// read from the drag only once it is dropped, so the list also notes it here while it is on the way.
export const CONVERSATION_DRAG_TYPE = 'application/x-conclave-conversation'

let dragging: string | null = null

export function startConversationDrag(transfer: DataTransfer, id: string): void {
  transfer.setData(CONVERSATION_DRAG_TYPE, id)
  transfer.effectAllowed = 'move'
  dragging = id
}

export function endConversationDrag(): void {
  dragging = null
}

export function draggedConversation(): string | null {
  return dragging
}
