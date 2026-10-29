import { t } from '../i18n'
import type { WorkActivity } from '../work-activity'

// The card already identifies its Agent in the footer; this line only says what is happening.
export function TaskActivity({ activity }: { activity: WorkActivity }) {
  const state = activity.state === 'awaiting' ? t('ChatWorking.waitingForYourAnswer') : t('TaskActivity.running')
  const action = activity.detail?.trim()
  const text = activity.state === 'awaiting' ? action ? `${state}：${action}` : state
    : action || (activity.workers.length > 1 ? t('TaskActivity.agentsRunning', { value1: activity.workers.length }) : state)
  const title = `${activity.workers.map((worker) => worker.name).join('、')} · ${state}${action ? `\n${action}` : ''}`
  return <span className="task-card-activity" data-state={activity.state} title={title} aria-label={title.replaceAll('\n', '：')}>
    <span className="task-card-activity-dot" aria-hidden="true" />
    <span className="task-card-activity-text">{text}</span>
  </span>
}
