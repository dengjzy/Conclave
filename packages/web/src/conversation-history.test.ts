import { describe, expect, it } from 'vitest'
import { Conversation } from '@conclave/protocol'
import { arrangeHistory, conversationHistory, historyGroupOf, historyKey, historyMatches, shownHistoryRows, sortHistory } from './conversation-history'

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const single = (n: number) => Conversation.parse({ id: id(n), title: `single ${n}`, titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [], managedWorkspace: false, sessionId: null, createdAt: n, updatedAt: n })

describe('conversation history', () => {
  it('lists free single conversations while excluding nested member, task and deleting conversations', () => {
    const normal = single(1)
    const recent = single(5)
    const member = { ...single(2), discussionId: id(3) }
    const task = { ...single(4), taskId: id(8) }
    const child = { ...single(6), parentConversationId: normal.id }
    const deleting = { ...single(7), deletion: { state: 'running' as const } }
    const failedDeletion = { ...single(8), deletion: { state: 'failed' as const, error: 'err' } }
    const entries = conversationHistory(Object.fromEntries([normal, recent, member, task, child, deleting, failedDeletion].map((value) => [value.id, value])))
    expect(sortHistory(entries, 'recent').map(historyKey)).toEqual([`single:${failedDeletion.id}`, `single:${recent.id}`, `single:${normal.id}`])
  })

  it('pins conversations and groups shared projects without losing created/title sorting', () => {
    const normal = { ...single(1), projectPaths: ['/projects/cache'] }
    const newer = { ...single(3), projectPaths: ['/projects/cache'] }
    const pinned = { ...single(2), pinnedAt: 9 }
    const entries = conversationHistory({ [normal.id]: normal, [newer.id]: newer, [pinned.id]: pinned })
    const groups = arrangeHistory(entries, 'project', 'recent')
    expect(groups[0]?.key).toBe('pinned')
    expect(groups[1]?.items.map(historyKey)).toEqual([`single:${newer.id}`, `single:${normal.id}`])
    expect(sortHistory(entries, 'created').map((entry) => entry.value.createdAt)).toEqual([3, 2, 1])
    expect(sortHistory(entries, 'title').map((entry) => entry.value.title)).toEqual(['single 1', 'single 2', 'single 3'])
  })

  it('matches titles and projects and groups by status and agent', () => {
    const running = { ...single(1), projectPaths: ['/projects/cache'], sessionId: 's1' }
    const entry = { kind: 'single', value: running } as const
    expect(historyMatches(entry, 'cache')).toBe(true)
    expect(historyMatches(entry, 'single 1')).toBe(true)
    expect(historyMatches(entry, 'unrelated')).toBe(false)
    expect(historyGroupOf(entry, 'status').rank).toBe(0)
    expect(historyGroupOf(entry, 'agent').label).toBe('Claude Code')
  })

  it('keeps the selected conversation visible beyond a group limit', () => {
    const entries = conversationHistory({ [id(1)]: single(1), [id(2)]: single(2), [id(3)]: single(3) })
    expect(shownHistoryRows(entries, `single:${id(3)}`, 1).map(historyKey)).toEqual([`single:${id(1)}`, `single:${id(3)}`])
  })
})
