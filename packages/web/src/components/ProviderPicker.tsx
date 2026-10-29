import { t } from '../i18n'
import { MODEL_PROVIDER_PRESETS, type AgentKind } from '@conclave/protocol'
import { setSettingsOpen, useCore } from '../core-store'
import { agentLabel } from '../labels'
import { servingProviders } from '../model-provider-choice'
import { ChatPicker, type PickerSize } from './ChatPicker'

// Where a new conversation or task's agent runs: its own account, or one of the user's model
// providers that serves it. Shown only where there is a provider to pick; '' is the own account.
export function ProviderPicker({ agent, value, onChange, disabled = false, placement, size }: {
  agent: AgentKind
  value: string | null
  onChange: (providerId: string | null) => void
  disabled?: boolean
  placement?: 'above' | 'below'
  size?: PickerSize
}) {
  const providers = servingProviders(useCore((s) => s.modelProviders), agent)
  if (providers.length === 0) return null
  const picked = providers.some((provider) => provider.id === value) ? value : null
  return (
    <ChatPicker
      label={t('ProviderPicker.provider')}
      value={picked ?? ''}
      placeholder={t('ProviderPicker.ownAccount', { value1: agentLabel(agent) })}
      disabled={disabled}
      placement={placement}
      size={size}
      options={[
        { value: '', label: t('ProviderPicker.ownAccount', { value1: agentLabel(agent) }), description: t('ProviderPicker.ownAccountDescription', { value1: agentLabel(agent) }) },
        ...providers.map((provider) => ({
          value: provider.id,
          label: provider.name,
          description: [provider.defaultModel, provider.preset !== 'custom' && !MODEL_PROVIDER_PRESETS[provider.preset].verified ? t('ModelProviderSettings.unverified') : null].filter(Boolean).join(' · ')
        }))
      ]}
      onChange={(next) => onChange(next || null)}
      footer={(close) => (
        <button type="button" role="menuitem" className="menu-item" onClick={() => { close(); setSettingsOpen(true, 'model-providers') }}>{t('ProviderPicker.manage')}</button>
      )}
    />
  )
}
