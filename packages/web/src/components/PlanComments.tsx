import { t } from '../i18n'
import type { RefObject } from 'react'
import { SelectionComment } from './SelectionComment'

// Text selected in a plan opens a box to say something about it. Each comment joins the chat's
// quotes: while the plan waits they go back with it to keep planning, otherwise they wait in the
// input like any quote. A plan is read to comment on, so the box takes the focus as it opens.
export function PlanComments({ conversationId, planKey, body }: { conversationId: string; planKey: string; body: RefObject<HTMLElement | null> }) {
  return <SelectionComment conversationId={conversationId} container={body} region=".chat-plan-body" sourceOf={() => planKey} name="plan" label={t('PlanComments.commentOnThisPlanPassage')} focus copyMenu />
}
