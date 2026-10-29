import { useEffect } from 'react'
import { type Squad, type SquadFields, type SquadRun } from '@conclave/protocol'
import { perform, selectSquad, useCore } from './core-store'
import { replaySummaryChanges } from './attention-summaries'

export async function saveSquad(fields: SquadFields, id?: string): Promise<Squad | null> {
  const squad = await perform((rpc) => id ? rpc.call('squads.update', { id, ...fields }) : rpc.call('squads.create', fields))
  if (squad) {
    useCore.setState((state) => ({ squads: { ...state.squads, [squad.id]: squad } }))
    selectSquad(squad.id)
  }
  return squad
}

export function useSquadRuns(taskId: string): SquadRun[] {
  const rpc = useCore((state) => state.rpc)
  const runs = useCore((state) => state.squadRuns)
  useEffect(() => {
    if (!rpc?.features.includes('squads')) return
    let current = true
    const changes = new Map<string, SquadRun | null>()
    const off = rpc.on('squads.runChanged', ({ run }) => { if (run.taskId === taskId) changes.set(run.id, run) })
    void rpc.call('squads.runs', { id: taskId }).then((list) => {
      if (!current) return
      useCore.setState((state) => ({ squadRuns: { ...state.squadRuns, ...replaySummaryChanges(list, changes) } }))
    }, (error: unknown) => {
      if (current) useCore.setState({ error: error instanceof Error ? error.message : String(error) })
    }).finally(off)
    return () => { current = false; off() }
  }, [rpc, taskId])
  return Object.values(runs).filter((run) => run.taskId === taskId).sort((a, b) => b.createdAt - a.createdAt)
}
