import { t } from '../i18n'
import type { ChatItem } from '@conclave/protocol'
import { dollars, smallModelExplanation } from '../model-cost-format'
import { compact } from '../stat-format'

export function HelperTurnCost({ turn }: { turn: Extract<ChatItem, { kind: 'turn' }> }) {
  const cost = turn.smallModelCost
  if (!cost) return null
  const tokens = turn.usage ? 'total' in turn.usage ? turn.usage.total : turn.usage.input + turn.usage.output : null
  return <span className="helper-turn-cost" title={smallModelExplanation(cost)}>
    {cost.costUsd !== null ? t('HelperTurnCost.cost', { value1: dollars(cost.costUsd) }) : tokens !== null ? t('HelperTurnCost.tokensCostUnavailable', { value1: compact(tokens) }) : t('HelperTurnCost.usageUnavailable')}
    {cost.savedUsd !== null && t('HelperTurnCost.savedAbout', { value1: dollars(cost.savedUsd) })}
  </span>
}
