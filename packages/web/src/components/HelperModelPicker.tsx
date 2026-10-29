import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { helperAllowsMode, type AgentKind, type ChatCatalog, type ChatPermissionMode, type Conversation } from '@conclave/protocol'
import { perform, useCore } from '../core-store'
import { helperProvider } from '../helper-conversations'
import { ChatModelPicker, ChatPicker } from './ChatPicker'
import { effortLabel, modeOptions, modeTone, startModes } from './ChatOptionsBar'

// providerId: the model provider the helper runs on (helperProvider), whose models it picks from.
export function useHelperCatalog(agent: AgentKind, providerId?: string): ChatCatalog | null | undefined {
  const rpc = useCore((state) => state.rpc)
  const key = `${agent}|${providerId ?? ''}`
  const [result, setResult] = useState<{ key: string; catalog: ChatCatalog | null } | null>(null)
  useEffect(() => {
    if (!rpc) return
    let current = true
    void rpc.call('conversations.chatCatalog', { agent, ...(providerId ? { modelProvider: providerId } : {}) }).then((catalog) => {
      if (current) setResult({ key, catalog })
    }).catch(() => { if (current) setResult({ key, catalog: null }) })
    return () => { current = false }
  }, [rpc, agent, providerId, key])
  return result?.key === key ? result.catalog : undefined
}

export function HelperModelPicker({ catalog, model, effort, disabled = false, onModel, onEffort }: {
  catalog: ChatCatalog | null | undefined
  model: string | null
  effort: string | null
  disabled?: boolean
  onModel: (model: string) => void
  onEffort: (effort: string) => void
}) {
  if (!catalog) return <span className="muted">{catalog === undefined ? t('AgentModelPicker.loadingModels') : model ?? t('ChatPicker.defaultModel')}</span>
  return <ChatModelPicker
    models={catalog.models.map((each) => ({ value: each.id, label: each.label, description: each.description, efforts: each.efforts.map((one) => ({ value: one, label: effortLabel(one) })) }))}
    model={model}
    effort={effort}
    disabled={disabled}
    onModel={onModel}
    onEffort={onEffort}
  />
}

// What a helper can start in with the model picked: a new chat's modes, less planning.
export function helperModes(agent: AgentKind, catalog: ChatCatalog | null | undefined, model: string | null): ChatPermissionMode[] {
  return startModes(agent, catalog?.models.find((each) => model ? each.id === model : each.isDefault)).filter(helperAllowsMode)
}

// A mode the model no longer takes reads as asking, as the helper then starts.
export function helperMode(offered: readonly ChatPermissionMode[], mode: string | null): ChatPermissionMode {
  return offered.find((each) => each === mode) ?? 'ask'
}

export function HelperModePicker({ agent, offered, mode, disabled = false, onMode }: {
  agent: AgentKind
  offered: readonly string[]
  mode: string
  disabled?: boolean
  onMode: (mode: string) => void
}) {
  return <ChatPicker label={t('ChatHandoff.permissionMode')} value={mode} placeholder={t('ChatHandoff.permissionMode')} options={modeOptions(agent, offered)} tone={modeTone(mode)} disabled={disabled} onChange={onMode} />
}

export function HelperStartOptions({ conversation }: { conversation: Conversation }) {
  const catalog = useHelperCatalog(conversation.agent, helperProvider(conversation))
  const set = (option: 'permissionMode' | 'model' | 'effort', value: string) => void perform((rpc) => rpc.call('conversations.setOption', { id: conversation.id, option, value }))
  const model = conversation.chatOptions?.model ?? null
  const offered = helperModes(conversation.agent, catalog, model)
  const disabled = Boolean(conversation.starting)
  return <>
    <HelperModePicker agent={conversation.agent} offered={offered} mode={helperMode(offered, conversation.chatOptions?.permissionMode ?? null)} disabled={disabled} onMode={(value) => set('permissionMode', value)} />
    <span className="chat-dock-spacer" />
    <HelperModelPicker catalog={catalog} model={model} effort={conversation.chatOptions?.effort ?? null} disabled={disabled} onModel={(value) => set('model', value)} onEffort={(value) => set('effort', value)} />
  </>
}
