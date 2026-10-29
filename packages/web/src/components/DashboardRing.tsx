import type { ReactNode } from 'react'
import { finePercent } from '../stat-format'

export type RingPart = { key: string; label: ReactNode; value: number; detail: string; graph: number }

// A circumference of 100, so each part's length is its percentage.
const RADIUS = 15.9155
const GAP = 0.8

// Parts of one whole around a ring, its total in the middle; a part shows however small it is.
export function DashboardRing({ parts, total, caption, onPick }: { parts: readonly RingPart[]; total: string; caption: string; onPick?: (key: string) => void }) {
  const sum = parts.reduce((all, part) => all + part.value, 0)
  const shown = parts.filter((part) => part.value > 0)
  const gap = shown.length > 1 ? GAP : 0
  let offset = 0
  return (
    <div className="dashboard-ring-body">
      <div className="dashboard-ring" aria-hidden="true">
        <svg viewBox="0 0 36 36">
          <circle className="dashboard-ring-track" r={RADIUS} cx="18" cy="18" />
          {sum > 0 && shown.map((part) => {
            const share = (part.value / sum) * 100
            const length = Math.max(0.6, share - gap)
            const arc = <circle key={part.key} data-graph={part.graph} r={RADIUS} cx="18" cy="18" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-offset} />
            offset += share
            return arc
          })}
        </svg>
        <span className="dashboard-ring-total">
          <b>{total}</b>
          <span>{caption}</span>
        </span>
      </div>
      <ul className="dashboard-ring-parts">
        {parts.map((part) => {
          const content = (
            <>
              <span className="dashboard-ring-swatch" data-graph={part.graph} />
              <span className="dashboard-ring-name">{part.label}</span>
              <span className="dashboard-ring-share">{sum > 0 ? finePercent(part.value / sum) : '—'}</span>
              <span className="dashboard-ring-detail">{part.detail}</span>
            </>
          )
          return <li key={part.key}>{onPick ? <button type="button" onClick={() => onPick(part.key)}>{content}</button> : content}</li>
        })}
      </ul>
    </div>
  )
}
