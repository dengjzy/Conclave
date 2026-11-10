import { describe, expect, it } from 'vitest'
import { Conversation, Discussion } from '@conclave/protocol'
import { arrangeHistory, conversationHistory, historyGroupOf, historyKey, historyMatches, shownHistoryRows, sortHistory } from './conversation-history'

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const single = (n: number) => Conversation.parse({ id: id(n), title: `single ${n}`, titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [], managedWorkspace: false, sessionId: null, createdAt: n, updatedAt: n })
const group = (n: number) => Discussion.parse({ id: id(n), title: `group ${n}`, topic: 'Compare cache designs', projectPaths: ['/projects/cache'], members: [], chairId: id(99), maxRounds: 1, anonymous: false, state: 'done', step: null, round: 1, lastRound: 1, pinnedAt: null, createdAt: n, updatedAt: n })

describe('combined conversation history', () => {
  it('interleaves single and group chats while excluding nested member and task conversations', () => {
    const normal = single(1)
    const recent = single(5)
    const member = { ...single(2), discussionId: id(3) }
    const task = { ...single(4), taskId: id(8) }
    const child = { ...single(6), parentConversationId: normal.id }
    const deleting = { ...single(7), deletion: { state: 'running' as const } }
    const failedDeletion = { ...single(8), deletion: { state: 'failed' as const, error: 'err' } }
    const discussion = group(3)
    const entries = conversationHistory(Object.fromEntries([normal, recent, member, task, child, deleting, failedDeletion].map((value) => [value.id, value])), { [discussion.id]: discussion })
    expect(sortHistory(entries, 'recent').map(historyKey)).toEqual([`single:${failedDeletion.id}`, `single:${recent.id}`, `group:${discussion.id}`, `single:${normal.id}`])
    expect(conversationHistory({ [normal.id]: normal }, { [discussion.id]: discussion }, 'single').map(historyKey)).toEqual([`single:${normal.id}`])
    expect(conversationHistory({ [normal.id]: normal }, { [discussion.id]: discussion }, 'group').map(historyKey)).toEqual([`group:${discussion.id}`])
  })

  it('pins both types and groups shared projects without losing created/title sorting', () => {
    const normal = { ...single(1), projectPaths: ['/projects/cache'] }
    const discussion = group(3)
    const pinned = { ...single(2), pinnedAt: 9 }
    const entries = conversationHistory({ [normal.id]: normal, [pinned.id]: pinned }, { [discussion.id]: discussion })
    const groups = arrangeHistory(entries, 'project', 'recent')
    expect(groups[0]?.key).toBe('pinned')
    expect(groups[1]?.items.map(historyKey)).toEqual([`group:${discussion.id}`, `single:${normal.id}`])
    expect(sortHistory(entries, 'created').map((entry) => entry.value.createdAt)).toEqual([3, 2, 1])
    expect(sortHistory(entries, 'title').map((entry) => entry.value.title)).toEqual(['group 3', 'single 1', 'single 2'])
  })

  it('finds group topics, projects, members and models without showing member conversations twice', () => {
    const discussion = Discussion.parse({ ...group(1), members: [{ id: id(2), conversationId: id(3), name: 'Auditor', role: '', agent: 'codex', model: 'gpt-6-astra', effort: null, status: 'awaiting' }] })
    const entry = { kind: 'group', value: discussion } as const
    for (const query of ['cache', 'Auditor', 'gpt-6-astra', 'Compare']) expect(historyMatches(entry, query)).toBe(true)
    expect(historyMatches(entry, 'unrelated')).toBe(false)
    expect(historyGroupOf(entry, 'status').rank).toBe(0)
    expect(historyGroupOf(entry, 'agent').label).toBe('群聊')
  })

  it('keeps the selected group visible beyond a group limit and distinguishes identical ids', () => {
    const entries = conversationHistory({ [id(1)]: single(1), [id(2)]: single(2) }, { [id(1)]: group(1) })
    expect(shownHistoryRows(entries, `group:${id(1)}`, 1).map(historyKey)).toEqual([`single:${id(1)}`, `group:${id(1)}`])
  })
})
