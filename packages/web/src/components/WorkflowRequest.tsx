import type { ChatItem } from '@conclave/protocol'
import { isPlanApproval } from '@conclave/protocol'
import type { WorkflowEvent } from '../workflow-events'
import { t } from '../i18n'
import { ChatApprovalCard, ChatQuestionCard } from './ChatRequestCards'

// Historical requests remain records, even when another stage reuses the request ID.
export function WorkflowRequest({ event, conversationId, items, connected }: {
  event: WorkflowEvent; conversationId: string | null; items: readonly ChatItem[]; connected: boolean
}) {
  const item = event.item
  if (!conversationId || event.phase !== 'awaiting' || !item || (item.kind !== 'approval' && item.kind !== 'question') || item.resolution !== null || isPlanApproval(item)) return null
  const tool = item.kind === 'approval' ? items.find((entry): entry is Extract<ChatItem, { kind: 'tool' }> => entry.kind === 'tool' && entry.id === item.toolItemId && entry.stageId === item.stageId) : undefined
  return <fieldset className="wf-request" disabled={!connected} aria-label={t('WorkflowStudio.respondHere')}>
    <legend>{t('WorkflowStudio.respondHere')}</legend>
    {!connected && <p className="muted" role="status">{t('WorkflowProcess.offline')}</p>}
    {item.kind === 'approval'
      ? <ChatApprovalCard key={`${item.stageId}/${item.id}`} conversationId={conversationId} item={{ ...item, detail: null }} tool={tool} singleApproval />
      : <ChatQuestionCard key={`${item.stageId}/${item.id}`} conversationId={conversationId} item={item} />}
  </fieldset>
}
