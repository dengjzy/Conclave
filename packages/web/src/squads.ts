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

export async function createDefaultSquad(installed: readonly import('@conclave/protocol').AgentKind[]): Promise<Squad | null> {
  const leaderId = crypto.randomUUID()
  const devId = crypto.randomUUID()
  const testId = crypto.randomUUID()
  const reviewId = crypto.randomUUID()
  const leaderAgent = installed[0] ?? 'claude'
  const devAgent = installed[1] ?? installed[0] ?? 'codex'
  const testAgent = installed[2] ?? installed[0] ?? 'codex'
  const reviewAgent = installed[3] ?? installed[1] ?? installed[0] ?? 'claude'

  return saveSquad({
    name: '全自动研发与验证小队',
    description: '主导、执行、测试、验证四角色自动协同推进，用户只负责最终验收成果',
    instructions: '严格遵循自驱流水线：队长主导评估与架构拆解 -> 开发成员编写代码 -> 测试成员执行验证与回打修复 -> 审查成员交叉质检 -> 队长汇总成果提请验收。',
    leaderId,
    members: [
      { id: leaderId, name: '架构与协调队长', agent: leaderAgent, model: null, effort: null, capability: 'readOnly', role: '主导需求评估与架构拆解，安排工序并协调成员推进，汇总交付成果' },
      { id: devId, name: '核心开发工程师', agent: devAgent, model: null, effort: null, capability: 'develop', role: '负责业务代码实现、架构落地与 Bug 修复' },
      { id: testId, name: '测试与质量保障', agent: testAgent, model: null, effort: null, capability: 'develop', role: '运行构建与自动化测试，验证功能完整性，拦截运行错误' },
      { id: reviewId, name: '代码审查与核验员', agent: reviewAgent, model: null, effort: null, capability: 'readOnly', role: '交叉 Review 代码规范、边界漏洞与变更真实性' }
    ]
  })
}
