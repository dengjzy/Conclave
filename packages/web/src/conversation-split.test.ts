import { describe, expect, it } from 'vitest'
import type { Conversation } from '@conclave/protocol'
import { canSplit, closePane, panesAfterSelect, panesBeside, restorePanes, shownPanes, splitPanesOf, type SplitPanes } from './conversation-split'

const conversation = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id, title: id, titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [], managedWorkspace: true,
  sessionId: null, createdAt: 0, updatedAt: 0, ...patch
})
const pair: SplitPanes = ['a', 'b']

describe('conversation split', () => {
  it('reads a saved pair only when it names two different conversations', () => {
    expect(splitPanesOf(['a', 'b'])).toEqual(['a', 'b'])
    expect(splitPanesOf(['a'])).toBeNull()
    expect(splitPanesOf(['a', 'a'])).toBeNull()
    expect(splitPanesOf([])).toBeNull()
  })

  it('shows the pair only while one of the two is in front', () => {
    expect(shownPanes(pair, 'b')).toEqual(pair)
    expect(shownPanes(pair, 'c')).toBeNull()
    expect(shownPanes(pair, null)).toBeNull()
  })

  it('brings one of the two forward, puts another in place of the one in front, and leaves from elsewhere', () => {
    expect(panesAfterSelect(pair, 'a', 'b')).toEqual(pair)
    expect(panesAfterSelect(pair, 'a', 'c')).toEqual(['c', 'b'])
    expect(panesAfterSelect(pair, 'b', 'c')).toEqual(['a', 'c'])
    // From the overview, a task or nothing: the pair goes.
    expect(panesAfterSelect(pair, null, 'c')).toBeNull()
    // Closing the view keeps the pair for when one of them comes back.
    expect(panesAfterSelect(pair, 'a', null)).toEqual(pair)
    expect(panesAfterSelect(null, 'a', 'c')).toBeNull()
  })

  it('opens beside the one in front: on its right, or in place of the other column', () => {
    expect(panesBeside(null, 'a', 'c')).toEqual(['a', 'c'])
    expect(panesBeside(pair, 'a', 'c')).toEqual(['a', 'c'])
    expect(panesBeside(pair, 'b', 'c')).toEqual(['c', 'b'])
    expect(panesBeside(pair, 'a', 'b')).toEqual(pair)
    // A pair not on screen is not the one opened beside.
    expect(panesBeside(pair, 'c', 'd')).toEqual(['c', 'd'])
    expect(panesBeside(null, null, 'c')).toBeNull()
    expect(panesBeside(null, 'a', 'a')).toBeNull()
  })

  it('keeps the other column on closing one', () => {
    expect(closePane(pair, 'a')).toBe('b')
    expect(closePane(pair, 'b')).toBe('a')
  })

  it('pairs only conversations of the list, and brings the last pair back as it was', () => {
    expect(canSplit(conversation('a'))).toBe(true)
    expect(canSplit(conversation('t', { taskId: 'task' }))).toBe(false)
    expect(canSplit(conversation('h', { helperOf: 'a' }))).toBe(false)
    expect(canSplit(conversation('x', { archivedAt: 1 }))).toBe(false)
    const conversations = {
      a: conversation('a', { updatedAt: 5 }),
      b: conversation('b', { updatedAt: 1 }),
      c: conversation('c', { updatedAt: 9 }),
      t: conversation('t', { updatedAt: 20, taskId: 'task' })
    }
    // Each side where it was, whichever of the two is in front.
    expect(restorePanes('b', ['a', 'b'], conversations)).toEqual(['a', 'b'])
    expect(restorePanes('a', ['a', 'b'], conversations)).toEqual(['a', 'b'])
    // From a conversation outside the pair, it goes on the left beside one of that pair.
    expect(restorePanes('c', ['a', 'b'], conversations)).toEqual(['c', 'a'])
    // The other of the pair is gone: the most recent other conversation of the list.
    expect(restorePanes('a', ['a', 'gone'], conversations)).toEqual(['a', 'c'])
    expect(restorePanes('a', [], conversations)).toEqual(['a', 'c'])
    expect(restorePanes('a', [], { a: conversations.a })).toBeNull()
  })
})
