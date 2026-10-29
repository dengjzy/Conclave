import { agentDescriptor, type AgentKind, type AgentReadiness } from '@conclave/protocol'
import { t } from './i18n'

export function agentReadinessText(readiness: AgentReadiness, agent?: AgentKind): string {
  if (readiness.state === 'ready') return t(readiness.via === 'account' ? 'Readiness.accountReady' : 'Readiness.providerReady')
  if (readiness.state === 'provider-failed') return t('SetupGuide.providerFailed')
  if (readiness.state === 'unknown-auth' && agent && agentDescriptor(agent).setup === 'provider') return t('Readiness.unknownProvider')
  return t(`Readiness.${readiness.state}`)
}
