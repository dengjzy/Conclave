import { t } from '../i18n'
import { useState } from 'react'
import type { Task } from '@conclave/protocol'
import { useCore, useSquadsSupported } from '../core-store'
import { agentLabel, dayAndTime } from '../labels'
import { ChevronDownIcon } from './icons'
import { MarkdownEditor } from './MarkdownEditor'

const ignore = () => {}

// The plan settled in the task's chat, read-only: the details stay as the user wrote them. A saved
// one waits for the task to run, so it opens; an approved one is already being carried out.
export function TaskPlanCard({ task }: { task: Task }) {
  const { plan } = task
  const supported = useSquadsSupported()
  const [open, setOpen] = useState(plan ? !plan.approved : false)
  if (!plan) {
    return null
  }
  const title = plan.approved ? t('TaskPlanCard.approvedPlan') : t('TaskPlanCard.savedPlan')
  return (
    <section className="snapshot" data-open={open || undefined} aria-label={title}>
      <header className="snapshot-header">
        <button type="button" className="snapshot-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDownIcon />
          {title}
        </button>
        <span className="muted">
          {agentLabel(plan.agent)} · {dayAndTime(plan.createdAt)}
          {!plan.approved && t('TaskPlanCard.sharedWithAgentWhenExecutionStarts')}
        </span>
      </header>
      {supported && task.status === 'pending' && !task.squadId && <button type="button" className="link-button" onClick={() => useCore.setState({ taskLaunchId: task.id, squadPlan: null, squadLaunch: true })}>{t('TaskPlanCard.chooseDevelopmentSquad')}</button>}
      {open && (
        <MarkdownEditor key={plan.createdAt} value={plan.markdown} onSave={ignore} label={title} hint="" readOnly />
      )}
    </section>
  )
}
