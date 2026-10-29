import { useState, type ComponentProps } from 'react'
import { useCore } from '../core-store'

// Counts jump as a connection loads what it holds, and that is no news; only a change once it has
// settled is marked.
const SETTLE_MS = 2000
let settledAt = Number.POSITIVE_INFINITY
useCore.subscribe((next, previous) => {
  if (next.connection === previous.connection) return
  settledAt = next.connection === 'connected' ? Date.now() + SETTLE_MS : Number.POSITIVE_INFINITY
})

type CountChange = { up: boolean; n: number }

// How a count moving from `previous` to `next` is marked; `n` grows so each change restarts.
export function countChange(previous: number, next: number, last: CountChange | null, settled: boolean): CountChange | null {
  return settled ? { up: next > previous, n: (last?.n ?? 0) + 1 } : null
}

// A sidebar entry's count. A rise sends a ring out once and rolls the new number in; a fall only
// rolls it, as less to do needs no one's attention. Kept mounted at zero, so the first one arriving
// is a rise too.
export function CountBadge({ count, className, ...props }: { count: number } & Omit<ComponentProps<'span'>, 'children'>) {
  const [seen, setSeen] = useState(count)
  const [change, setChange] = useState<CountChange | null>(null)
  if (count !== seen) {
    setSeen(count)
    setChange(countChange(seen, count, change, Date.now() >= settledAt))
  }
  if (count <= 0) return null
  // A new key restarts the animation on every change, even one following straight on another.
  return (
    <span key={change?.n} className={`inbox-entry-count${className ? ` ${className}` : ''}`} data-change={change ? (change.up ? 'up' : 'down') : undefined} {...props}>
      <span className="inbox-entry-count-digits">{count}</span>
    </span>
  )
}
