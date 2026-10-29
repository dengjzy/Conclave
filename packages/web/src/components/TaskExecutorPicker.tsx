import { t } from '../i18n'
import type { AgentKind, Squad, Task } from '@conclave/protocol'
import { updateTask, useCore } from '../core-store'
import { useInstalledAgents } from '../installed-agents'
import { agentLabel } from '../labels'
import { useRecommendation } from './AgentQuota'
import { ChatPicker, type PickerOption, type PickerSize } from './ChatPicker'
import { AgentIcon, SquadIcon } from './icons'

// Who can carry a task out, as a picker lists them: later, one agent, or a squad (value squad:<id>),
// an archived squad only when it is the one picked.
// `recommended`: the agent best spent now, by its quota (useRecommendation).
export function executorOptions(agents: readonly AgentKind[], squads: Readonly<Record<string, Squad>>, squadId: string | null, recommended: AgentKind | null = null): PickerOption[] {
  const listed = Object.values(squads).filter((each) => each.archivedAt === null || each.id === squadId)
  return [
    { value: '', label: t('TaskExecutorPicker.chooseLater'), icon: <AgentIcon agent={null} /> },
    ...agents.map((agent) => ({ value: agent, label: agentLabel(agent), description: agent === recommended ? t('TaskExecutorPicker.recommendedSingleAgent') : t('TaskExecutorPicker.singleAgent'), icon: <AgentIcon agent={agent} /> })),
    ...listed.map((each) => ({
      value: `squad:${each.id}`,
      label: each.name,
      description: t('TaskExecutorPicker.developmentSquadMembers', { value1: each.members.length - 1, value2: each.archivedAt !== null ? t('TaskExecutorPicker.archived') : '' }),
      icon: <SquadIcon />
    }))
  ]
}

// Who carries a pending task out: one agent, or a squad, picked as the app's other pickers pick.
export function TaskExecutorPicker({ task, size }: { task: Task; size?: PickerSize }) {
  const squads = useCore((state) => state.squads)
  const agents = useInstalledAgents()
  const recommended = useRecommendation(agents)?.agent ?? null
  const value = task.squadId ? `squad:${task.squadId}` : task.agent ?? ''
  return (
    <span className="task-executor-picker">
      <span className="muted">{t('NewTaskDialog.assignee')}</span>
      <ChatPicker
        label={t('TaskExecutorPicker.taskAssignee')}
        value={value}
        placeholder={task.squadId ? t('NewTaskDialog.developmentSquad') : t('TaskExecutorPicker.chooseLater')}
        options={executorOptions(agents, squads, task.squadId ?? null, recommended)}
        size={size}
        placement="below"
        align="end"
        disabled={task.status !== 'pending'}
        onChange={(picked) => {
          if (picked.startsWith('squad:')) void updateTask(task.id, { squadId: picked.slice(6) })
          else void updateTask(task.id, { squadId: null, agent: agents.find((agent) => agent === picked) ?? null })
        }}
      />
    </span>
  )
}
