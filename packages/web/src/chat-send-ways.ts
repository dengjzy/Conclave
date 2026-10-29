import { IS_MAC } from './shortcut-keys'

export type SendWay = 'send' | 'interrupt' | 'queue' | 'steer' | 'newConversation'

// The ways the input can go now, the button's own first: send while the agent is idle; while it
// works, stop, then wait for the turn or go into it.
export function sendWays(state: { working: boolean; queueable: boolean; steerable: boolean; reusable: boolean }): SendWay[] {
  const now: SendWay[] = state.working
    ? ['interrupt', ...(state.queueable ? ['queue' as const] : []), ...(state.queueable && state.steerable ? ['steer' as const] : [])]
    : ['send']
  return state.reusable ? [...now, 'newConversation'] : now
}

const PRIMARY = IS_MAC ? '⌘' : 'Ctrl'
const SHIFT = IS_MAC ? '⇧' : 'Shift'
const ENTER = IS_MAC ? '↩' : 'Enter'

// Each key on its own cap, as the composer's key handler reads them.
export function sendWayKeys(way: SendWay): string[] {
  switch (way) {
    case 'send':
    case 'queue': return [ENTER]
    case 'steer': return [PRIMARY, ENTER]
    case 'newConversation': return [PRIMARY, SHIFT, ENTER]
    case 'interrupt': return ['Esc']
  }
}
