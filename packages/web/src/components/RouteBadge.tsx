import { t } from '../i18n'
import type { Conversation } from '@conclave/protocol'
import { agentLabel } from '../labels'
import { LockIcon } from './icons'

// What a conversation's agent runs on, where it was started on a model provider: the provider by
// name, fixed for the conversation; dimmed where the agent now runs on its own account, and a
// warning where the provider can no longer be reached.
export function RouteBadge({ conversation, locked = false }: { conversation: Pick<Conversation, 'agent' | 'route'>; locked?: boolean }) {
  const { route } = conversation
  if (!route) return null
  const name = route.name ?? t('RouteBadge.removedProvider')
  const title = route.reason === 'served' ? t('RouteBadge.onProvider', { value1: name })
    : route.reason === 'agent-unsupported' ? t('RouteBadge.ownAccount', { value1: agentLabel(conversation.agent), value2: name })
    : t('RouteBadge.unavailable', { value1: name })
  return (
    <span className="route-badge" data-reason={route.reason} data-tooltip={title} aria-label={title}>
      {locked && <LockIcon />}
      {route.reason === 'agent-unsupported' ? t('RouteBadge.ownAccountShort', { value1: agentLabel(conversation.agent) }) : name}
    </span>
  )
}
