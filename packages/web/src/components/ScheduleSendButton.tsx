import { t, tr } from '../i18n'
import { useCallback, useEffect, useState } from 'react'
import { chatReferencesFor, type ChatReference } from '@conclave/protocol'
import { usePlans } from '../chat-state'
import { ClockIcon } from './icons'
import { SchedulePicker } from './SchedulePicker'
import { createSchedule } from '../schedules'
import { composeMessage, type ChatQuote } from '../chat-quotes'
import { shiftMentions } from '../chat-mentions'

export interface ScheduleSendButtonProps {
  conversationId?: string
  text: string
  references: ChatReference[]
  quotes?: readonly ChatQuote[]
  images?: readonly string[]
  disabledReason?: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onScheduled?: () => void
  onScheduleCustom?: (notBefore: number | null, draftText: string) => Promise<boolean>
}

// Sends what the input holds later, unattended: once its time comes and the agent has quota again.
// In an existing conversation, an empty input schedules carrying out the plan the chat has; with no plan, it schedules nothing.
// When creating a new conversation (no conversationId), onScheduleCustom creates the deferred conversation and registers the run.
export function ScheduleSendButton({
  conversationId,
  text,
  references,
  quotes = [],
  images = [],
  disabledReason = null,
  open: controlledOpen,
  onOpenChange,
  onScheduled,
  onScheduleCustom
}: ScheduleSendButtonProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const setOpen = useCallback((next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }, [isControlled, onOpenChange])

  const [draft, setDraft] = useState('')
  const plans = usePlans(conversationId ?? '')
  const planned = conversationId ? plans.length > 0 : false

  const close = useCallback(() => setOpen(false), [setOpen])
  const toggle = () => {
    if (!open) setDraft(text)
    setOpen(!open)
  }

  useEffect(() => {
    if (open) setDraft(text)
  }, [open, text])

  const extras = [
    images.length ? t('ChatComposer.images', { value1: images.length }) : null,
    quotes.length ? t('ChatComposer.quotes_242', { value1: quotes.length }) : null
  ].filter(Boolean)

  return (
    <span className="menu-anchor chat-schedule-anchor">
      <button
        type="button"
        className="tool-button chat-schedule-button"
        aria-label={t('ChatComposer.scheduleMessage')}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabledReason !== null}
        data-tooltip={disabledReason ?? t('ChatComposer.scheduleSendWhenQuotaResetsOrAtA')}
        data-tooltip-side="top-end"
        onClick={toggle}
      >
        <ClockIcon />
      </button>
      {open && (
        <SchedulePicker
          title={t('ChatComposer.scheduleMessage')}
          align="end"
          empty={!planned && draft.trim() === '' && quotes.length === 0 && images.length === 0}
          onSchedule={async (notBefore) => {
            if (onScheduleCustom) {
              const success = await onScheduleCustom(notBefore, draft)
              if (success) onScheduled?.()
              return success
            }
            if (!conversationId) return false
            const message = composeMessage(quotes, draft)
            const run = await createSchedule({
              kind: 'conversation',
              conversationId,
              text: message.trim(),
              references: chatReferencesFor(draft, message.trim(), shiftMentions(references, text, draft, null)),
              ...(images.length ? { images: [...images] } : {})
            }, notBefore)
            if (run) onScheduled?.()
            return run !== null
          }}
          onClose={close}
        >
          {/* The message itself, written or changed here; empty, the agent carries out the chat's plan. */}
          <textarea
            className="input schedule-message"
            rows={3}
            value={draft}
            aria-label={t('ChatComposer.instructionsToSendToAgentWhenDue')}
            placeholder={planned ? t('ChatComposer.instructionsWhenDueLeaveEmptyToImplementThe') : t('ChatComposer.messageToSendWhenDue')}
            onChange={(event) => setDraft(event.target.value)}
          />
          {extras.length > 0 && (
            <div className="schedule-extras">
              {extras.map((extra) => <span key={extra} className="schedule-extra">{tr('ChatComposer.attach', { extra: extra })}</span>)}
            </div>
          )}
        </SchedulePicker>
      )}
    </span>
  )
}
