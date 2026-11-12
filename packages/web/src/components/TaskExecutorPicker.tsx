import { t } from '../i18n'
import type { AgentKind, Task } from '@conclave/protocol'
import { updateTask } from '../core-store'
import { useInstalledAgents } from '../installed-agents'
import { agentLabel } from '../labels'
import { useRecommendation } from './AgentQuota'
import { ChatPicker, type PickerOption, type PickerSize } from './ChatPicker'
import { AgentIcon } from './icons'

// Who can carry a task out, as a picker lists them: later, or one agent.
// `recommended`: the agent best spent now, by its quota (useRecommendation).
export function executorOptions(agents: readonly AgentKind[], recommended: AgentKind | null = null): PickerOption[] {
  return [
    { value: '', label: t('TaskExecutorPicker.chooseLater'), icon: <AgentIcon agent={null} /> },
    ...agents.map((agent) => ({ value: agent, label: agentLabel(agent), description: agent === recommended ? t('TaskExecutorPicker.recommendedSingleAgent') : t('TaskExecutorPicker.singleAgent'), icon: <AgentIcon agent={agent} /> }))
  ]
}

// Who carries a pending task out: one agent, picked as the app's other pickers pick.
export function TaskExecutorPicker({ task, size }: { task: Task; size?: PickerSize }) {
  const agents = useInstalledAgents()
  const recommended = useRecommendation(agents)?.agent ?? null
  return (
    <span className="task-executor-picker">
      <span className="muted">{t('NewTaskDialog.assignee')}</span>
      <ChatPicker
        label={t('TaskExecutorPicker.taskAssignee')}
        value={task.agent ?? ''}
        placeholder={t('TaskExecutorPicker.chooseLater')}
        options={executorOptions(agents, recommended)}
        size={size}
        placement="below"
        align="end"
        disabled={task.status !== 'pending'}
        onChange={(picked) => {
          void updateTask(task.id, { squadId: null, agent: agents.find((agent) => agent === picked) ?? null })
        }}
      />
    </span>
  )
}
