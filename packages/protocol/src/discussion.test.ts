import { describe, expect, it } from 'vitest'
import { DEFAULT_DISCUSSION_REQUIREMENTS, DiscussionCreate, MAX_DISCUSSION_REQUIREMENTS, checkAddDiscussionMember, checkDiscussionAction, checkEditDiscussionProjects, checkArchiveDiscussion, checkNewDiscussionTopic, checkRemoveDiscussionMember, currentTopic, memberLetter } from './discussion'

describe('discussion requirements', () => {
  const create = { topic: 'Compare caches', projectPaths: [], members: [{ agent: 'claude', name: 'Ann' }, { agent: 'codex', name: 'Bob' }], chair: 0 }

  it('keeps older requests valid and distinguishes omitted from explicitly empty requirements', () => {
    expect(DiscussionCreate.parse(create).requirements).toBe(DEFAULT_DISCUSSION_REQUIREMENTS)
    expect(DiscussionCreate.parse({ ...create, requirements: '   ' }).requirements).toBe('')
    expect(DiscussionCreate.parse({ ...create, requirements: '  Use tables.  ' }).requirements).toBe('Use tables.')
  })

  it('rejects oversized or malformed requirements before starting agents', () => {
    expect(DiscussionCreate.safeParse({ ...create, requirements: 'x'.repeat(MAX_DISCUSSION_REQUIREMENTS + 1) }).success).toBe(false)
    expect(DiscussionCreate.safeParse({ ...create, requirements: null }).success).toBe(false)
  })
})

describe('checkDiscussionAction', () => {
  it('pauses and stops only what runs, and not the summary', () => {
    expect(checkDiscussionAction({ state: 'running', step: 'round' }, 'pause')).toBeNull()
    expect(checkDiscussionAction({ state: 'running', step: 'summary' }, 'pause')).toBe('summing-up')
    expect(checkDiscussionAction({ state: 'paused', step: 'round' }, 'pause')).toBe('not-running')
    expect(checkDiscussionAction({ state: 'pausing', step: 'round' }, 'stop')).toBeNull()
    expect(checkDiscussionAction({ state: 'done', step: 'summary' }, 'stop')).toBe('not-running')
  })

  it('resumes a pause, adds a round to a pause or a finish, and concludes anything unfinished', () => {
    expect(checkDiscussionAction({ state: 'pausing', step: 'round' }, 'resume')).toBeNull()
    expect(checkDiscussionAction({ state: 'running', step: 'round' }, 'resume')).toBe('not-paused')
    expect(checkDiscussionAction({ state: 'done', step: 'summary' }, 'nextRound')).toBeNull()
    expect(checkDiscussionAction({ state: 'running', step: 'round' }, 'nextRound')).toBe('not-paused')
    expect(checkDiscussionAction({ state: 'paused', step: 'summary' }, 'conclude')).toBeNull()
    expect(checkDiscussionAction({ state: 'done', step: 'summary' }, 'conclude')).toBe('done')
  })
})

describe('changing a group chat midway', () => {
  const member = (id: string, position: number, status: 'idle' | 'working' = 'idle') => ({
    id, conversationId: id, agent: 'claude' as const, model: null, effort: null, name: id, role: '', status, position
  })
  const group = (members: ReturnType<typeof member>[], projectPaths: string[] = ['/repo']) => ({ members, formerMembers: [], chairId: 'a', projectPaths })

  it('lets members join up to the limit, and leave unless the chair, answering, or two are left', () => {
    expect(checkAddDiscussionMember(group(['a', 'b', 'c', 'd', 'e'].map((id, i) => member(id, i))))).toBe('full')
    expect(checkAddDiscussionMember(group([member('a', 0), member('b', 1)]))).toBeNull()
    const three = group([member('a', 0), member('b', 1, 'working'), member('c', 2)])
    expect(checkRemoveDiscussionMember(three, 'a')).toBe('chair')
    expect(checkRemoveDiscussionMember(three, 'b')).toBe('busy')
    expect(checkRemoveDiscussionMember(three, 'c')).toBeNull()
    expect(checkRemoveDiscussionMember(group([member('a', 0), member('c', 2)]), 'c')).toBe('too-few')
  })

  it('changes projects only where there are some and everyone is idle', () => {
    expect(checkEditDiscussionProjects(group([member('a', 0), member('b', 1)], []))).toBe('no-projects')
    expect(checkEditDiscussionProjects(group([member('a', 0), member('b', 1, 'working')]))).toBe('busy')
    expect(checkEditDiscussionProjects(group([member('a', 0), member('b', 1)]))).toBeNull()
  })

  it('moves on to a new topic only once nothing is out, and knows the topic now discussed', () => {
    const idle = [member('a', 0), member('b', 1)]
    expect(checkNewDiscussionTopic({ state: 'running', members: idle })).toBe('busy')
    expect(checkNewDiscussionTopic({ state: 'pausing', members: idle })).toBe('busy')
    expect(checkNewDiscussionTopic({ state: 'paused', members: [member('a', 0), member('b', 1, 'working')] })).toBe('busy')
    expect(checkNewDiscussionTopic({ state: 'done', members: idle })).toBeNull()
    expect(checkArchiveDiscussion({ state: 'running', members: idle })).toBe('busy')
    expect(checkArchiveDiscussion({ state: 'paused', members: idle })).toBeNull()
    const said = (text: string, topic: boolean) => ({ text, topic })
    expect(currentTopic({ topic: 'first' }, [said('aside', false)])).toBe('first')
    expect(currentTopic({ topic: 'first' }, [said('second', true), said('third', true), said('aside', false)])).toBe('third')
  })

  it('keeps each member\'s letter by when it joined, a former one\'s too', () => {
    const left = { members: [member('a', 0), member('c', 2)], formerMembers: [member('b', 1)] }
    expect(['a', 'b', 'c'].map((id) => memberLetter(left, id))).toEqual(['A', 'B', 'C'])
    expect(memberLetter(left, 'nobody')).toBeNull()
  })
})
