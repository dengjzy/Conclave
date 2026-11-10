import { describe, expect, it } from 'vitest'
import type { FlowNode, RepoChanges, Task } from '@conclave/protocol'
import { flowChangeSummary, flowGlyph, flowWorktree } from './flow-trajectory'

describe('flow trajectory helpers', () => {
  it('uses a state glyph before the node kind', () => {
    expect(flowGlyph('plan', 'pending')).toBe('◇')
    expect(flowGlyph('implement', 'running')).toBe('◉')
    expect(flowGlyph('verify', 'done')).toBe('✓')
    expect(flowGlyph('verify', 'failed')).toBe('×')
  })

  it('shows the task worktree branch and path', () => {
    const task = { repos: [{ path: '/repo', worktreePath: '/wt', branch: 'feat/x', startRef: null, start: { ref: 'main', commit: 'c', note: null, at: 1 } }] } as unknown as Task
    expect(flowWorktree(task)).toEqual({ branch: 'feat/x', path: '/wt', base: 'main' })
  })

  it('sums what the run changed across the worktrees that have a compare point', () => {
    const changes = [
      { path: '/repo', branch: 'feat/x', base: 'abc', commits: [], files: [{ path: 'a.ts', oldPath: null, kind: 'modified', additions: 10, deletions: 2 }] },
      { path: '/other', branch: 'feat/y', base: 'def', commits: [], files: [{ path: 'b.ts', oldPath: null, kind: 'added', additions: 3, deletions: 0 }, { path: 'c.bin', oldPath: null, kind: 'added', additions: null, deletions: null }] },
      // A conversation running in a project root has no worktree to compare against.
      { path: '/plain', branch: null, base: null, commits: [], files: [{ path: 'd.ts', oldPath: null, kind: 'modified', additions: 9, deletions: 9 }] }
    ] as unknown as RepoChanges[]
    expect(flowChangeSummary(changes)).toEqual({
      files: 3,
      added: 13,
      removed: 2,
      repos: [
        { repo: '/repo', files: changes[0]!.files },
        { repo: '/other', files: changes[1]!.files }
      ]
    })
  })

  it('separates no answer yet from an answer with nothing changed', () => {
    expect(flowChangeSummary(null)).toBeNull()
    expect(flowChangeSummary([])).toEqual({ files: 0, added: 0, removed: 0, repos: [] })
  })
})
