import { t } from '../i18n'
import type { TaskSource } from '@conclave/protocol'
import { ExternalIcon } from './icons'

// The issue an imported task, or a conversation looking into it, came from, one click away.
export function SourceLink({ source }: { source: TaskSource | null | undefined }) {
  if (!source) {
    return null
  }
  return (
    <a className="source-link" href={source.url} target="_blank" rel="noreferrer" data-tooltip={t('ConversationDraft.openIn', { value1: source.name })} data-tooltip-align="start">
      {source.key}
      <ExternalIcon />
    </a>
  )
}
