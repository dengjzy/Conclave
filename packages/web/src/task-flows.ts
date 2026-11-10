import { useEffect, useState } from 'react'
import type { Flow } from '@conclave/protocol'
import { useCore } from './core-store'

// A task's runs, newest first, read again whenever core says a run changed. `loading` is true until
// this task's first answer, so a panel does not draw "no run" before it has looked.
export function useTaskFlows(taskId: string): { flows: Flow[]; loading: boolean } {
  const rpc = useCore((state) => state.rpc)
  const revision = useCore((state) => state.flowsRevision)
  const [read, setRead] = useState<{ taskId: string; flows: Flow[] } | null>(null)
  useEffect(() => {
    if (!rpc || !rpc.features.includes('flows')) return
    let live = true
    void rpc.call('flows.list', { taskId })
      .then((list) => { if (live) setRead({ taskId, flows: list }) })
      .catch(() => { if (live) setRead({ taskId, flows: [] }) })
    return () => { live = false }
  }, [rpc, taskId, revision])
  return { flows: read?.taskId === taskId ? read.flows : [], loading: read?.taskId !== taskId }
}
