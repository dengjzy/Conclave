import { agentDescriptor, type AgentKind } from '@conclave/protocol'
import { t } from '../i18n'
import { InfoIcon } from './icons'

// Whether the agent's file tools reach only the primary project, given others as well.
export function reachesOnlyPrimary(agent: AgentKind | null | undefined, projectCount: number): agent is AgentKind {
  return Boolean(agent && projectCount > 1 && agentDescriptor(agent).primaryOnlyFiles)
}

// One quiet line, with the why on hover.
export function OtherProjectsHint({ agent, projectCount }: { agent: AgentKind | null | undefined; projectCount: number }) {
  if (!reachesOnlyPrimary(agent, projectCount)) return null
  const label = agentDescriptor(agent).label
  return (
    <p className="other-projects-hint" data-tooltip-align="start" data-tooltip={t('OtherProjectsHint.detail', { value1: label })}>
      <InfoIcon />
      {t('OtherProjectsHint.summary', { value1: label })}
    </p>
  )
}
