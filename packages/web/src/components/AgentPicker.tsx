import { t } from '../i18n'
import { quotaVerdict, type AgentKind } from '@conclave/protocol'
import { useCore } from '../core-store'
import { useInstalledAgents } from '../installed-agents'
import { agentLabel } from '../labels'
import { usePreferences } from '../preferences'
import { useNow } from '../usage-format'
import { quotaText, useRecommendation } from './AgentQuota'
import { ChatPicker, type PickerSize } from './ChatPicker'
import { AgentIcon } from './icons'

// A task's agent, as the app's other pickers choose one: each with its mark and how much of its
// quota is left. Locked while running (the session already started with this agent) and once
// abandoned. `labelled` sits it in a row of labelled buttons, as tall as they are.
export function AgentPicker({
  agent,
  locked,
  onChange,
  labelled = false,
  size = labelled ? 'large' : undefined
}: {
  agent: AgentKind | null
  locked: boolean
  onChange: (agent: AgentKind | null) => void
  labelled?: boolean
  size?: PickerSize
}) {
  const installed = useInstalledAgents()
  const usage = useCore((s) => s.usage)
  const display = usePreferences((s) => s.usageDisplay)
  const now = useNow(60_000)
  // The task's own agent stays in the list when it is not here, so what the task says is visible.
  const kinds = agent && !installed.includes(agent) ? [...installed, agent] : installed
  const recommended = useRecommendation(installed)?.agent
  return (
    <ChatPicker
      label="Agent"
      value={agent ?? ''}
      placeholder={t('AgentPicker.chooseAgent')}
      options={[
        ...kinds.map((kind) => ({
          value: kind,
          label: agentLabel(kind),
          icon: <AgentIcon agent={kind} />,
          description: installed.includes(kind)
            ? [kind === recommended ? t('AgentPicker.recommended') : null, quotaText(quotaVerdict(usage?.[kind], now), display, now)].filter(Boolean).join(' · ') || null
            : t('AgentPicker.notInstalled')
        })),
        ...(agent ? [{ value: '', label: t('AgentPicker.unspecified'), icon: <AgentIcon agent={null} /> }] : [])
      ]}
      size={size}
      placement="below"
      align="end"
      disabled={locked}
      title={locked ? t('AgentPicker.agentCannotChangeNow', { value1: agent ? agentLabel(agent) : t('AgentPicker.notSelected') }) : undefined}
      onChange={(value) => onChange(kinds.find((kind) => kind === value) ?? null)}
    />
  )
}
