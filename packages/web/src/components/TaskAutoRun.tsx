import { checkAutoRun, type Task } from '@conclave/protocol'
import { useId, useState } from 'react'
import { updateTask, useCore } from '../core-store'
import { t } from '../i18n'
import { reasonText } from '../labels'

export function TaskAutoRun({ task }: { task: Task }) {
  const supported = useCore((state) => state.rpc?.features.includes('task-auto-run') ?? false)
  const [saving, setSaving] = useState(false)
  const hintId = useId()
  if (!supported) return null
  const blocker = checkAutoRun(task)
  const disabled = saving || (!task.autoRun && blocker !== null)
  return (
    <div className="task-auto-run">
      <label className="task-auto-run-row">
        <span>{t('TaskDetail.autoRun')}</span>
        <span className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={task.autoRun ?? false}
            disabled={disabled}
            aria-label={t('TaskDetail.autoRun')}
            aria-describedby={hintId}
            onChange={async (event) => {
              setSaving(true)
              try { await updateTask(task.id, { autoRun: event.target.checked }) }
              finally { setSaving(false) }
            }}
          />
          <span className="switch-track" aria-hidden="true" />
        </span>
      </label>
      <p id={hintId}>{!task.autoRun && blocker ? reasonText(blocker, blocker) : t('TaskDetail.autoRunHint')}</p>
    </div>
  )
}
