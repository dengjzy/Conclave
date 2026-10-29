import { t } from '../i18n'
import type { WorkActivity } from '../work-activity'
import { AgentIcon } from './icons'

// Who is at work, as one mark wherever it shows: their icons, overlapped past the first, then
// who works (the words shimmer while they do) or that the user is waited on (still, in the warning
// colour), then what they are on.
export function WorkingSummary({ activity, detail = true }: { activity: WorkActivity; detail?: boolean }) {
  const names = activity.workers.map((worker) => worker.name)
  const label = activity.state === 'awaiting' ? t('ChatWorking.waitingForYourAnswer') : names.length > 2 ? t('WorkingSummary.membersWorking', { value1: names.length }) : t('WorkingSummary.working', { value1: names.join('、') })
  return (
    <span className="working-summary" data-state={activity.state} title={activity.detail ?? label}>
      <span className="working-stack" aria-hidden="true">
        {activity.workers.slice(0, 3).map((worker, index) => <AgentIcon key={`${worker.name}-${index}`} agent={worker.agent} />)}
      </span>
      <span className="working-label">{label}</span>
      {detail && activity.detail && <span className="working-detail">{activity.detail}</span>}
    </span>
  )
}
