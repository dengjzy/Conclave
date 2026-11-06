import { useEffect, useState } from 'react'
import { agentModeText, type AgentKind, type ChatCatalog, type ChatItem, type Conversation, type RemotePermissionMode, type RemoteResult } from '@conclave/protocol'
import { ChatModelPicker, ChatPicker } from '../components/ChatPicker'
import { getLocale } from '../i18n'
import type { MobileConnection } from './mobile-connection'

export type MobileAgentChoice = { agent: AgentKind | null; model?: string; effort?: string; agentPreset?: string; permissionMode?: RemotePermissionMode }
export type MobileCatalog = RemoteResult<'catalog'>
export function initialAgentChoice(catalog: MobileCatalog | null): MobileAgentChoice {
  const agent = catalog?.agents[0]
  return { agent: agent?.id ?? null, permissionMode: agent?.permissionModes?.[0], agentPreset: agent?.agentPresets?.defaultPreset }
}

export function MobileAgentOptions({ client, catalog, choice, onChange, disabled, conversation, state, placement = 'above', showPreset = true, showPermission = true, modelProvider }: {
  client: MobileConnection
  catalog: MobileCatalog
  choice: MobileAgentChoice
  onChange: (choice: MobileAgentChoice, option?: 'model' | 'effort' | 'permissionMode' | 'agentPreset') => void
  disabled: boolean
  conversation?: Conversation | null
  state?: Extract<ChatItem, { kind: 'state' }> | null
  placement?: 'above' | 'below'
  showPreset?: boolean
  showPermission?: boolean
  modelProvider?: Conversation['modelProvider']
}) {
  const [models, setModels] = useState<ChatCatalog | null>(null)
  const [problem, setProblem] = useState('')
  const hostId = client.activeHostId
  const provider = modelProvider ?? conversation?.modelProvider
  useEffect(() => {
    let active = true
    setModels(null); setProblem('')
    if (choice.agent && client.connected && client.supports('conversations.chatCatalog')) {
      void client.call('conversations.chatCatalog', { agent: choice.agent, ...(provider ? { modelProvider: provider } : {}) })
        .then((value) => { if (active) setModels(value) })
        .catch(() => { if (active) setProblem('模型列表暂不可用') })
    }
    return () => { active = false }
  }, [client, hostId, client.connected, choice.agent, provider])
  const agentKind = choice.agent
  const agent = catalog.agents.find((entry) => entry.id === choice.agent)
  const offered = state?.models.length ? state.models : models?.models ?? []
  const selectedModel = offered.find((entry) => entry.id === (state?.model ?? choice.model)) ?? offered.find((entry) => entry.isDefault)
  const permissionModes = (agent?.permissionModes ?? []).filter((mode) => !state?.permissionModes.length || state.permissionModes.includes(mode))
  const change = (option: 'model' | 'effort' | 'permissionMode' | 'agentPreset', value: string) => {
    if (option === 'permissionMode') {
      const mode = permissionModes.find((entry) => entry === value)
      if (mode) onChange({ ...choice, permissionMode: mode }, option)
    } else onChange({ ...choice, [option]: value, ...(option === 'model' ? { effort: undefined } : {}) }, option)
  }
  return <div className="mobile-agent-options" aria-label="Agent 与模型">
    {!conversation && <ChatPicker label="Agent" value={choice.agent} placeholder="选择 Agent" options={catalog.agents.map((entry) => ({ value: entry.id, label: entry.name }))} disabled={disabled || !catalog.agents.length} placement={placement} onChange={(value) => {
      const next = catalog.agents.find((entry) => entry.id === value)
      if (next) onChange({ agent: next.id, permissionMode: next.permissionModes?.[0], agentPreset: next.agentPresets?.defaultPreset })
    }} />}
    {conversation && <span className="mobile-agent-name">{agent?.name ?? conversation.agent}</span>}
    {offered.length > 0 && <ChatModelPicker models={offered.map((model) => ({ value: model.id, label: model.label, description: model.description, efforts: model.efforts.map((effort) => ({ value: effort, label: effort })) }))} model={selectedModel?.id ?? null} effort={state?.effort ?? choice.effort ?? null} onModel={(value) => change('model', value)} onEffort={(value) => change('effort', value)} disabled={disabled || conversation?.chat?.turn === 'running'} placement={placement} />}
    {showPermission && permissionModes.length > 0 && agentKind && <ChatPicker label="权限" value={state?.permissionMode ?? choice.permissionMode ?? permissionModes[0] ?? null} placeholder="权限" options={permissionModes.map((mode) => ({ value: mode, label: agentModeText(agentKind, mode, getLocale())?.label ?? mode, description: agentModeText(agentKind, mode, getLocale())?.description }))} onChange={(value) => change('permissionMode', value)} disabled={disabled} placement={placement} />}
    {showPreset && agent?.agentPresets && catalog.capabilities?.includes('agent-presets') && <ChatPicker label="Agent 预设" value={choice.agentPreset ?? agent.agentPresets.defaultPreset} placeholder="默认预设" options={agent.agentPresets.options.map((preset) => ({ value: preset.id, label: preset.label, description: preset.description }))} onChange={(value) => change('agentPreset', value)} disabled={disabled || conversation?.chat?.turn === 'running'} placement={placement} />}
    {problem && <small className="mobile-muted" role="status">{problem}</small>}
  </div>
}
