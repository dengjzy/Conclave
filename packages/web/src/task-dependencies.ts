import type { Task } from '@conclave/protocol'

export type DependencyRect = { left: number; right: number; top: number; bottom: number }
export type DependencyCard = { rect: DependencyRect; column: DependencyRect; index: number }
export type DependencyLine = { from: string; to: string; path: string }

function visibleCenter(card: DependencyCard): number | null {
  const y = (card.rect.top + card.rect.bottom) / 2
  return y > card.column.top && y < card.column.bottom ? y : null
}

// Gutters carry the lines; dependencies spanning several columns go below them, clear of cards.
export function dependencyLines(tasks: readonly Pick<Task, 'id' | 'dependsOn'>[], cards: ReadonlyMap<string, DependencyCard>, railY: number): DependencyLine[] {
  const lines: DependencyLine[] = []
  for (const task of tasks) {
    const target = cards.get(task.id)
    if (!target) continue
    const endY = visibleCenter(target)
    if (endY === null) continue
    for (const id of new Set(task.dependsOn)) {
      if (id === task.id) continue
      const source = cards.get(id)
      if (!source) continue
      const startY = visibleCenter(source)
      if (startY === null) continue
      let path: string
      if (source.index === target.index) {
        const lane = (source.column.left + source.rect.left) / 2
        path = `M ${source.rect.left} ${startY} H ${lane} V ${endY} H ${target.rect.left}`
      } else {
        const forward = source.index < target.index
        const startX = forward ? source.rect.right : source.rect.left
        const endX = forward ? target.rect.left : target.rect.right
        if (Math.abs(source.index - target.index) === 1) {
          const lane = (startX + endX) / 2
          path = `M ${startX} ${startY} H ${lane} V ${endY} H ${endX}`
        } else {
          const exit = (startX + (forward ? source.column.right : source.column.left)) / 2
          const entry = (endX + (forward ? target.column.left : target.column.right)) / 2
          path = `M ${startX} ${startY} H ${exit} V ${railY} H ${entry} V ${endY} H ${endX}`
        }
      }
      lines.push({ from: id, to: task.id, path })
    }
  }
  return lines
}
