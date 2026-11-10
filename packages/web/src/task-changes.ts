import { useEffect, useState } from 'react'
import type { RepoChanges } from '@conclave/protocol'
import { useCore } from './core-store'
import { useFocusCount } from './components/Inspector'

// A task's repos as they are now, from where each worktree's branch started. Read again whenever
// the task changes, the window regains focus, or git moves; a client on an older core shows none.
export function useTaskChanges(taskId: string, updatedAt: number, refreshCount: number): RepoChanges[] | null {
  const gitRevision = useCore((state) => state.gitRevision)
  const rpc = useCore((state) => state.rpc)
  const focusCount = useFocusCount()
  const [changes, setChanges] = useState<{ taskId: string; changes: RepoChanges[] } | null>(null)
  useEffect(() => {
    if (!rpc) return
    let current = true
    void rpc.call('tasks.changes', { id: taskId })
      .catch(() => [])
      .then((found) => {
        if (current) setChanges({ taskId, changes: found })
      })
    return () => {
      current = false
    }
  }, [rpc, taskId, updatedAt, focusCount, refreshCount, gitRevision])
  return changes?.taskId === taskId ? changes.changes : null
}
