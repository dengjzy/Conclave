import { isHelper } from '@conclave/protocol'
import { actionableItems, type ActionableItem, type Snapshot } from './attention'
import type { Mood } from './pet-brain'

export function petMood(s: Snapshot): { mood: Mood; attention: ActionableItem | null } {
  const items = actionableItems(s)
  const waiting = items.find((item) => item.primaryReason === 'awaiting' || (item.primaryReason === 'reply' && item.request !== null))
  if (waiting) return { mood: 'waiting', attention: waiting }
  const failed = items.find((item) => item.primaryReason === 'crashed')
  if (failed) return { mood: 'failed', attention: failed }
  const conversations = Object.values(s.conversations).filter((c) => c.archivedAt == null && !isHelper(c))
  if (conversations.some((c) => c.chat?.turn === 'running')) return { mood: 'running', attention: null }
  const reply = items.find((item) => item.primaryReason === 'reply')
  if (reply) return { mood: 'waiting', attention: reply }
  if (items.some((item) => item.primaryReason === 'review') || conversations.some((c) => s.unseen[c.id])) return { mood: 'review', attention: null }
  return { mood: 'idle', attention: null }
}
