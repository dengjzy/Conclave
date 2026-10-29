import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { BoardColumn } from '../task-board'
import { dependencyLines, type DependencyCard, type DependencyLine } from '../task-dependencies'

export function TaskDependencies({ columns, children }: { columns: readonly BoardColumn[]; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null)
  const marker = useId()
  const [lines, setLines] = useState<DependencyLine[]>([])
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const active = hovered ?? focused

  useLayoutEffect(() => {
    const shown = columns.flatMap((column) => column.tasks)
    if (!shown.some((task) => task.dependsOn.length > 0)) {
      setLines((previous) => previous.length ? [] : previous)
      return
    }
    const root = viewport.current
    const board = root?.querySelector<HTMLElement>('.task-board-columns')
    if (!root || !board) return
    let frame = 0
    const measure = () => {
      const bounds = root.getBoundingClientRect()
      const cards = new Map<string, DependencyCard>()
      const relative = (rect: DOMRect) => ({ left: rect.left - bounds.left, right: rect.right - bounds.left, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top })
      board.querySelectorAll<HTMLElement>('.task-board-column').forEach((column, index) => {
        const rect = relative(column.getBoundingClientRect())
        const header = column.querySelector('.task-board-column-title')?.getBoundingClientRect()
        const clip = { ...rect, top: header ? header.bottom - bounds.top : rect.top, bottom: rect.top + column.clientHeight }
        column.querySelectorAll<HTMLElement>('[data-task-id]').forEach((card) => {
          if (card.dataset.taskId) cards.set(card.dataset.taskId, { rect: relative(card.getBoundingClientRect()), column: clip, index })
        })
      })
      const next = dependencyLines(shown, cards, board.clientHeight - 12)
      setLines((previous) => previous.length === next.length && previous.every((line, index) => {
        const other = next[index]
        return other && line.from === other.from && line.to === other.to && line.path === other.path
      }) ? previous : next)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const resize = new ResizeObserver(schedule)
    const observe = () => {
      resize.disconnect()
      resize.observe(root)
      resize.observe(board)
      board.querySelectorAll('.task-board-column, .task-board-column > *').forEach((element) => resize.observe(element))
      schedule()
    }
    // Quick add and activity can change card positions without changing the task list.
    const changes = new MutationObserver(observe)
    changes.observe(board, { childList: true, subtree: true, characterData: true })
    observe()
    measure()
    root.addEventListener('scroll', schedule, true)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      changes.disconnect()
      root.removeEventListener('scroll', schedule, true)
    }
  }, [columns])

  const taskAt = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null : null
  return (
    <div
      ref={viewport}
      className="task-board-viewport"
      onMouseOver={(event) => setHovered(taskAt(event.target))}
      onMouseLeave={() => setHovered(null)}
      onFocusCapture={(event) => setFocused(taskAt(event.target))}
      onBlurCapture={(event) => setFocused(taskAt(event.relatedTarget))}
    >
      {children}
      <svg className="task-dependencies" aria-hidden="true" data-active={active !== null || undefined}>
        <defs>
          <marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 Z" fill="context-stroke" />
          </marker>
        </defs>
        {lines.map((line) => (
          <path
            key={`${line.from}:${line.to}`}
            className="task-dependency-line"
            data-related={active === line.from || active === line.to || undefined}
            d={line.path}
            markerEnd={`url(#${marker})`}
          />
        ))}
      </svg>
    </div>
  )
}
