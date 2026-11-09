import type { RpcConnection } from '@conclave/protocol'
import { dropChat, setChatPage } from './chat-state'

// The event workspace and the transcript share one server subscription per connection.
const watches = new WeakMap<RpcConnection, Map<string, { count: number }>>()
const owners = new Map<string, object>()
export function retainChat(rpc: RpcConnection, id: string): () => void {
  let group = watches.get(rpc)
  if (!group) { group = new Map(); watches.set(rpc, group) }
  let entry = group.get(id)
  if (!entry) {
    entry = { count: 0 }
    group.set(id, entry)
    owners.set(id, entry)
    const started = entry
    void rpc.call('conversations.watchChat', { id }).then((page) => {
      if (group.get(id) === started && owners.get(id) === started) setChatPage(id, page)
    }, () => {})
  }
  entry.count++
  const kept = entry
  let released = false
  return () => {
    if (released) return
    released = true
    if (--kept.count > 0) return
    group.delete(id)
    if (owners.get(id) === kept) { owners.delete(id); dropChat(id) }
    void rpc.call('conversations.unwatchChat', { id }).catch(() => {})
  }
}
