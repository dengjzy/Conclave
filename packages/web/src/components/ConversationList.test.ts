import { describe, expect, it } from 'vitest'
import type { Conversation } from '@conclave/protocol'
import { GROUP_LIMIT, groupOf, metaProjects, shownRows } from './ConversationList'

const base: Conversation = {
  id: '11111111-1111-4111-8111-111111111111', title: 't', titleLocked: false, agent: 'claude', workspacePath: '/w',
  projectPaths: [], managedWorkspace: true, sessionId: null, createdAt: 0, updatedAt: 0
}

describe('groupOf', () => {
  it('puts a conversation under its primary project, whatever else it reaches, and one without last', () => {
    expect(groupOf({ ...base, projectPaths: ['/code/conclave', '/code/lobehub', '/code/multica'] }, 'project')).toEqual({ label: 'conclave', rank: 0 })
    expect(groupOf({ ...base, projectPaths: ['/code/conclave'] }, 'project')).toEqual({ label: 'conclave', rank: 0 })
    expect(groupOf(base, 'project')).toEqual({ label: '无项目', rank: 1 })
  })
})

describe('metaProjects', () => {
  it('leaves the primary project to its heading, naming only the others it reaches', () => {
    expect(metaProjects(['/code/conclave', '/code/orca', '/code/multica'], true)).toBe('+orca、multica')
    expect(metaProjects(['/code/conclave'], true)).toBeNull()
    expect(metaProjects([], true)).toBeNull()
    expect(metaProjects(['/code/conclave', '/code/orca'], false)).toBe('conclave、orca')
    expect(metaProjects([], false)).toBe('无项目')
  })
})

describe('shownRows', () => {
  const items = Array.from({ length: 9 }, (_, index) => ({ ...base, id: `c${index}` }))

  it("shows a group's first rows, and the open conversation wherever it falls", () => {
    expect(shownRows(items, null).map((each) => each.id)).toEqual(items.slice(0, GROUP_LIMIT).map((each) => each.id))
    expect(shownRows(items, 'c8').map((each) => each.id)).toEqual([...items.slice(0, GROUP_LIMIT).map((each) => each.id), 'c8'])
    expect(shownRows(items.slice(0, 3), 'c1')).toHaveLength(3)
  })

  it('shows a few more rows each time the group is asked for them', () => {
    expect(shownRows(items, null, GROUP_LIMIT + 2).map((each) => each.id)).toEqual(items.slice(0, GROUP_LIMIT + 2).map((each) => each.id))
    expect(shownRows(items, null, GROUP_LIMIT * 2)).toHaveLength(9)
  })
})
