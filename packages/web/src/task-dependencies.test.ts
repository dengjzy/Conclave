import { describe, expect, it } from 'vitest'
import { boardColumns, DONE_SHOWN } from './task-board'
import { dependencyLines, type DependencyCard } from './task-dependencies'
import { Task } from '@conclave/protocol'

function card(index: number, top = 60): DependencyCard {
  const left = index * 260
  return { index, column: { left, right: left + 240, top: 40, bottom: 500 }, rect: { left: left + 20, right: left + 220, top, bottom: top + 80 } }
}

describe('task dependency lines', () => {
  it.each([0, 1])('points from the prerequisite to the dependent across adjacent columns (source column %s)', (index) => {
    const source = card(index)
    const target = card(1 - index, 200)
    const [line] = dependencyLines([{ id: 'next', dependsOn: ['first'] }], new Map([['first', source], ['next', target]]), 520)
    expect(line).toEqual({ from: 'first', to: 'next', path: index === 0 ? 'M 220 100 H 250 V 240 H 280' : 'M 280 100 H 250 V 240 H 220' })
  })

  it.each([60, 300])('keeps same-column dependencies in the gutter (source top %s)', (top) => {
    const [line] = dependencyLines([{ id: 'next', dependsOn: ['first'] }], new Map([['first', card(0, top)], ['next', card(0, 180)]]), 520)
    expect(line?.path).toBe(`M 20 ${top + 40} H 10 V 220 H 20`)
  })

  it.each([0, 3])('routes past intermediate columns below the cards (source column %s)', (index) => {
    const [line] = dependencyLines([{ id: 'next', dependsOn: ['first'] }], new Map([['first', card(index)], ['next', card(3 - index, 200)]]), 520)
    expect(line?.path).toBe(index === 0 ? 'M 220 100 H 230 V 520 H 790 V 240 H 800' : 'M 800 100 H 790 V 520 H 230 V 240 H 220')
  })

  it('omits missing, filtered and collapsed tasks without duplicating dependencies', () => {
    const cards = new Map([['first', card(0)], ['next', card(1)]])
    expect(dependencyLines([{ id: 'next', dependsOn: ['first', 'missing', 'first', 'next'] }, { id: 'hidden', dependsOn: ['first'] }], cards, 520)).toHaveLength(1)
  })

  it.each(['first', 'next'])('hides the line when %s scrolls under the sticky heading or out of its column', (id) => {
    for (const top of [-40, 480]) {
      const cards = new Map([['first', card(0)], ['next', card(1)]])
      cards.set(id, card(id === 'first' ? 0 : 1, top))
      expect(dependencyLines([{ id: 'next', dependsOn: ['first'] }], cards, 520)).toEqual([])
    }
  })

  it('follows measured positions after scrolling or resizing', () => {
    const cards = new Map([['first', card(0)], ['next', card(1)]])
    const tasks = [{ id: 'next', dependsOn: ['first'] }]
    const before = dependencyLines(tasks, cards, 520)
    const moved = card(1, 300)
    moved.rect.left += 80
    moved.rect.right += 80
    cards.set('next', moved)
    expect(dependencyLines(tasks, cards, 520)[0]?.path).toBe('M 220 100 H 290 V 340 H 360')
    expect(dependencyLines(tasks, cards, 520)).not.toEqual(before)
  })

  it('only connects the done tasks shown by the board, including earlier tasks when expanded', () => {
    const makeTask = (id: string, updatedAt: number) => Task.parse({ id, title: id, details: '', status: 'done', repos: [], dependsOn: [], agent: null, createdAt: 0, updatedAt })
    const tasks = Array.from({ length: DONE_SHOWN + 1 }, (_, index) => makeTask(`done${index}`, index))
    tasks.push({ ...makeTask('next', 20), status: 'pending', dependsOn: ['done0'] })
    const visible = (allDone: boolean) => boardColumns(tasks, { query: '', project: null, agent: null }, 'recent', { abandoned: false, allDone }).flatMap((column) => column.tasks)
    const measure = (shown: readonly Task[]) => new Map(shown.map((task) => [task.id, card(task.status === 'done' ? 3 : 0)]))
    expect(dependencyLines(visible(false), measure(visible(false)), 520)).toEqual([])
    expect(dependencyLines(visible(true), measure(visible(true)), 520)).toHaveLength(1)
  })
})
