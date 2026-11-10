import type { ChangedFile, FlowNode, RepoChanges, Task } from '@conclave/protocol'

// The glyph and the worktree summary are the small pieces the flow panel draws around the graph;
// keeping them pure makes the visual rules testable without rendering the panel.
export function flowGlyph(kind: FlowNode['kind'], state: FlowNode['state']): string {
  if (state === 'done') return '✓'
  if (state === 'failed') return '×'
  if (state === 'running') return '◉'
  if (kind === 'plan') return '◇'
  return '○'
}

export function flowWorktree(task: Task): { branch: string; path: string; base: string | null } | null {
  const repo = task.repos.find((each) => each.worktreePath) ?? task.repos[0]
  if (!repo) return null
  return {
    branch: repo.branch ?? 'detached',
    path: repo.worktreePath ?? repo.path,
    base: repo.start?.ref ?? repo.startRef ?? null
  }
}

export type WorktreeChanges = {
  files: number
  added: number
  removed: number
  // Only repos with a worktree to compare against; a conversation running in a project root has none.
  repos: { repo: string; files: ChangedFile[] }[]
}

// What the run changed so far, summed for the worktree bar. Null while the changes are still being
// read; an answer without a compare point is an empty summary, not an unknown one.
export function flowChangeSummary(changes: readonly RepoChanges[] | null): WorktreeChanges | null {
  if (changes === null) return null
  const repos = changes.filter((repo) => repo.base).map((repo) => ({ repo: repo.path, files: repo.files }))
  const files = repos.flatMap((each) => each.files)
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    repos
  }
}
