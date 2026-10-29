import { t } from '../i18n'
import type { Task } from '@conclave/protocol'

export function hasTaskAlerts(task: Task): boolean {
  return task.awaitingInput
}

// What needs the user's eye beyond the status: an agent waiting on them.
export function TaskAlerts({ task }: { task: Task }) {
  return task.awaitingInput && (
    <span className="task-tag task-tag-awaiting" title={t('TaskAlerts.agentFinishedThisTurnAndAwaitsYourReply')}>{t('TaskAlerts.waitingForYourReply')}</span>
  )
}
