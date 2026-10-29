import { getLocale, localized, t } from '../i18n'
import { agentDescriptor, agentModeText, helperAllowsMode, isHelper, type AgentKind, type ChatContextUse, type ChatItem, type ChatModel, type ChatOption, type ChatPermissionMode, type Conversation } from '@conclave/protocol'
import { perform, useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { useAgentCatalog } from '../agent-models'
import { providerFor } from '../model-provider-choice'
import { ChatModelPicker, ChatPicker, type PickerOption } from './ChatPicker'

type StateItem = Extract<ChatItem, { kind: 'state' }>

export function modeLabel(agent: AgentKind, mode: string): string {
  return agentModeText(agent, mode, getLocale())?.label ?? mode
}

// The modes as the picker lists them; one the agent offers but cannot be picked now stays greyed.
export function modeOptions(agent: AgentKind, modes: readonly string[], offered: readonly string[] = modes): PickerOption[] {
  return modes.map((mode) => ({
    value: mode,
    label: modeLabel(agent, mode),
    description: agentModeText(agent, mode, getLocale())?.description ?? null,
    disabled: !offered.includes(mode)
  }))
}

// Only the modes worth a second look stand out: planning, and running with nothing asked.
export function modeTone(mode: string | null): string | undefined {
  return mode === 'plan' || mode === 'bypass' ? mode : undefined
}

export function defaultStartMode(agent: AgentKind, offered: readonly ChatPermissionMode[]): ChatPermissionMode {
  const prefs = usePreferences.getState?.()
  const custom = prefs?.agentDefaultPermissions?.[agent]
  if (custom && offered.includes(custom as ChatPermissionMode)) return custom as ChatPermissionMode
  const globalMode = prefs?.globalDefaultPermission
  if (globalMode && offered.includes(globalMode as ChatPermissionMode)) return globalMode as ChatPermissionMode
  const { defaultStartMode: preferred, startModes } = agentDescriptor(agent)
  return offered.includes(preferred) ? preferred : startModes[0]!
}

// What a new conversation can start in, with auto where the model takes it (as the agent's catalog
// says) and bypass where the agent has it, in the order a running chat lists them.
export function startModes(agent: AgentKind, model: ChatModel | undefined): ChatPermissionMode[] {
  const { startModes, capabilities } = agentDescriptor(agent)
  return [...startModes, ...(model?.autoMode && capabilities.autoMode ? ['auto' as const] : []), ...(capabilities.bypass ? ['bypass' as const] : [])]
}

const EFFORT_LABEL: Record<string, string> = localized(() => ({
  none: t('ChatOptionsBar.none'),
  minimal: t('ChatOptionsBar.minimal'),
  low: t('ChatOptionsBar.low'),
  medium: t('ChatOptionsBar.medium'),
  high: t('ChatOptionsBar.high'),
  xhigh: t('ChatOptionsBar.extraHigh'),
  max: t('ChatOptionsBar.maximum'),
  ultra: t('ChatOptionsBar.ultra')
}))

export function effortLabel(effort: string): string {
  return EFFORT_LABEL[effort] ?? effort
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count)
}

// How full the context window is; before the window is known, only the tokens.
function ContextRing({ context }: { context: ChatContextUse }) {
  const ratio = context.window ? Math.min(1, context.used / context.window) : null
  const title = ratio === null
    ? t('ChatOptionsBar.contextTokens', { value1: tokens(context.used) })
    : t('ChatOptionsBar.context', { value1: Math.round(ratio * 100), value2: tokens(context.used), value3: tokens(context.window ?? 0) })
  const radius = 7
  const length = 2 * Math.PI * radius
  const level = ratio === null ? 'normal' : ratio >= 0.85 ? 'critical' : ratio >= 0.6 ? 'warning' : 'normal'
  return (
    <span className="chat-context" role="img" aria-label={title} data-tooltip={title} data-tooltip-side="top-end" data-level={level}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r={radius} className="chat-context-track" />
        {ratio !== null && (
          <circle cx="10" cy="10" r={radius} className="chat-context-fill" strokeDasharray={`${ratio * length} ${length}`} transform="rotate(-90 10 10)" />
        )}
      </svg>
      {ratio !== null && <span>{Math.round(ratio * 100)}%</span>}
    </span>
  )
}

// A choice the stage reports but does not list (a mode Conclave has no name for) still shows.
function withCurrent(values: readonly string[], current: string | null): string[] {
  return current && !values.includes(current) ? [current, ...values] : [...values]
}

// The composer's toolbar, inside its box after the ＋: how freely the agent may act on the left; on
// the right, the model and effort it runs beside how full its context is. A click switches each;
// the model and effort change between turns, the mode at any time. With no agent running, the
// choices are for the next start, from what the last stage offered: as chosen since, or as that
// stage left them.
export function ChatOptionsBar({ conversation, state, compact = false }: { conversation: Conversation; state: StateItem | null; compact?: boolean }) {
  const { id, agent, chatOptions: next } = conversation
  const managed = Boolean(conversation.squadRunId || conversation.parentConversationId || conversation.workspaceReadOnly)
  const running = conversation.sessionId !== null
  const providers = useCore((s) => s.modelProviders)
  const chosenProvider = providerFor(providers, conversation.modelProvider, agent)
  const catalog = useAgentCatalog(agent, true, chosenProvider)

  // Verify if state belongs to this agent
  const stateMatchesAgent = Boolean(
    state && (
      running
        ? true
        : (catalog?.models?.some((cm) => state.models.some((sm) => sm.id === cm.id)) ?? true)
    )
  )
  const activeState = stateMatchesAgent ? state : null

  // An older core takes options only from a running agent.
  if (!running && !next && !catalog) return null
  const idle = !running || conversation.chat?.turn === 'idle'
  const set = (option: ChatOption, value: string) => void perform((rpc) => rpc.call('conversations.setOption', { id, option, value }))

  // Models list: prefer catalog for this agent if available, fallback to activeState.models
  const availableModels = catalog?.models && catalog.models.length > 0
    ? catalog.models
    : (activeState?.models ?? [])

  // Resolve modelId:
  let modelId = (running && activeState) ? activeState.model : (next?.model ?? activeState?.model)
  if (!availableModels.some((m) => m.id === modelId)) {
    modelId = availableModels.find((m) => m.isDefault)?.id ?? availableModels[0]?.id ?? null
  }

  const currentModel = availableModels.find((each) => each.id === modelId)
  let effort = (running && activeState) ? activeState.effort : (next?.effort ?? (next?.model && next.model !== activeState?.model ? null : activeState?.effort))
  if (effort && currentModel && !currentModel.efforts.includes(effort)) {
    effort = currentModel.efforts[0] ?? null
  }

  const descriptor = agentDescriptor(agent)
  const offered = (running && activeState || conversation.planOnly
    ? (activeState?.permissionModes ?? startModes(agent, currentModel))
    : [...(activeState?.permissionModes ?? startModes(agent, currentModel)).filter((mode) => mode !== 'bypass'), ...(descriptor.capabilities.bypass ? ['bypass'] : [])]
  ).filter((mode) => !isHelper(conversation) || helperAllowsMode(mode))

  const permissionMode = (running && activeState)
    ? activeState.permissionMode
    : (next?.permissionMode ?? activeState?.permissionMode ?? defaultStartMode(agent, offered as readonly ChatPermissionMode[]))

  const modes = withCurrent(offered, permissionMode)
  const models = availableModels
  const later = running ? null : t('ChatOptionsBar.appliesWhenYouSendTheNextMessage')
  return (
    <>
      {modes.length > 0 && (
        <ChatPicker
          label={t('ChatHandoff.permissionMode')}
          value={permissionMode}
          placeholder={t('ChatHandoff.permissionMode')}
          options={modeOptions(agent, modes, offered).map((option) => conversation.workspaceReadOnly ? { ...option, label: conversation.squadRunId || conversation.profile ? t('ChatOptionsBar.readOnly') : t('ChatOptionsBar.readOnlyCoordination') } : option)}
          tone={modeTone(permissionMode)}
          disabled={managed || (!descriptor.capabilities.optionsWhileBusy && !idle)}
          title={managed ? t(conversation.profile ? 'AgentProfiles.fixedConfig' : 'ChatOptionsBar.useThisSquadSConfiguration') : later ?? undefined}
          onChange={(mode) => set('permissionMode', mode)}
        />
      )}
      <span className="chat-dock-spacer" />
      {models.length > 0 && (
        <ChatModelPicker
          models={models.map((each) => ({ value: each.id, label: each.label, description: each.description, efforts: each.efforts.map((one) => ({ value: one, label: effortLabel(one) })) }))}
          model={modelId ?? null}
          effort={effort ?? null}
          disabled={managed || !idle}
          title={managed ? t(conversation.profile ? 'AgentProfiles.fixedConfig' : 'ChatOptionsBar.useThisSquadSConfiguration') : later ?? (idle ? undefined : t('ChatOptionsBar.changeModelAndReasoningEffortAfterThisTurn'))}
          onModel={(value) => set('model', value)}
          onEffort={(value) => set('effort', value)}
        />
      )}
      {!compact && activeState?.context && running && <ContextRing context={activeState.context} />}
    </>
  )
}
