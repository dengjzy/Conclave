import { getLocale, localized, t, tr } from '../i18n'
import { useCallback, useEffect, useState, useRef, type KeyboardEvent } from 'react'
import { itemKey, type PlanItem } from '../chat-state'
import { composeFeedback, setQuotes, useQuotes } from '../chat-quotes'
import { planMarkdownFilename } from '../plan-markdown'
import { QuoteCards } from './ChatQuoteCards'
import { PlanComments } from './PlanComments'
import { useChatSurface } from './chat-surface'
import { ChatMarkdown } from './ChatMarkdown'
import { useResponder } from './ChatRequestCards'
import { ChatPicker } from './ChatPicker'
import { SchedulePicker } from './SchedulePicker'
import { perform, useCore, usePlanModesSupported, useSchedulesSupported } from '../core-store'
import { setPreference, usePreferences, type Preferences } from '../preferences'
import { ContextMenu, type MenuPoint } from './ContextMenu'
import { CheckIcon, ChevronDownIcon, CopyIcon, DownloadIcon } from './icons'
import { createSchedule } from '../schedules'
import { modeLabel } from './ChatOptionsBar'
import { agentDescriptor, type AgentKind } from '@conclave/protocol'

// Approving later, once the quota is back: an empty scheduled message approves the plan waiting.
function SchedulePlanButton({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <span className="menu-anchor chat-plan-schedule">
      <button type="button" className="link-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>{t('ChatPlan.scheduleApproval')}</button>
      {open && (
        <SchedulePicker
          align="end"
          title={t('ChatPlan.scheduleApprovalOfThisPlan')}
          note={t('ChatPlan.approveAndStartWhenDueWithoutWaitingFor')}
          onSchedule={async (notBefore) => (await createSchedule({ kind: 'conversation', conversationId, text: '' }, notBefore)) !== null}
          onClose={close}
        />
      )}
    </span>
  )
}

// A plan Claude proposes from plan mode reads beside the conversation, in the inspector; the
// list and the dock only point to it, and the dock takes the answer.

const RESOLUTION: Record<NonNullable<PlanItem['resolution']>, string> = localized(() => ({
  allowed: t('ChatPlan.implementPlanAskBeforeEachAction'),
  allowedForSession: t('ChatPlan.implementPlanAcceptEditsAutomatically'),
  denied: t('ChatPlan.continuePlanning'),
  // Stopped before it was answered, or the agent ended first: either way nothing was carried out.
  cancelled: t('ChatPlan.notExecuted')
}))

// The permission modes a plan can be carried out in, in the order the menu offers them.
type RunMode = Preferences['planRunMode']
const RUN_MODES: readonly RunMode[] = ['auto', 'acceptEdits', 'ask', 'bypass']
const RUN_MODE: Record<RunMode, { label: string; hint: string }> = localized(() => ({
  auto: { label: t('ChatPlan.automaticMode'), hint: t('ChatPlan.runSafeActionsDirectlyAskBeforeRiskyOnes') },
  acceptEdits: { label: t('ChatPlan.acceptEditsAutomatically'), hint: t('ChatPlan.editFilesDirectlyAskBeforeRunningCommands') },
  ask: { label: t('ChatPlan.askEachTime'), hint: t('ChatPlan.askBeforeEditingFilesOrRunningCommands') },
  bypass: { label: t('ChatPlan.allowEverything'), hint: t('ChatPlan.askNothingUseOnlyWhenYouTrustThis') }
}))

function isRunMode(mode: string): mode is RunMode {
  return RUN_MODES.some((each) => each === mode)
}

function status(plan: PlanItem): string {
  if (plan.resolution === null) return t('ChatPlan.awaitingYourApproval')
  if ((plan.resolution === 'allowed' || plan.resolution === 'allowedForSession') && plan.mode && isRunMode(plan.mode)) {
    return t('ChatPlan.implementPlan', { value1: plan.tool === 'cursor/create_plan' ? 'Agent' : RUN_MODE[plan.mode].label })
  }
  return RESOLUTION[plan.resolution]
}

// The execute button's mode: the one picked last, where the stage offers it; otherwise auto, then
// accepting edits. The arrow beside it opens the others the stage offers.
function RunModeButton({ modes, mode, disabled, onRun, agent }: { modes: readonly RunMode[]; mode: RunMode; disabled: boolean; onRun: () => void; agent: AgentKind }) {
  const arrow = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  return (
    <span className="plan-run">
      <button type="button" className="button primary plan-run-main" disabled={disabled} onClick={onRun}>{tr('ChatPlan.run', { value1: agentDescriptor(agent, getLocale()).nativePlanRun ? modeLabel(agent, mode) : RUN_MODE[mode].label, value2: <kbd>↵</kbd> })}</button>
      <button
        ref={arrow}
        type="button"
        className="button primary plan-run-arrow"
        aria-label={t('ChatPlan.choosePermissionsForExecution')}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        disabled={disabled}
        onClick={() => {
          const box = arrow.current?.getBoundingClientRect()
          if (at || !box) return close()
          setAt({ x: box.right, y: box.top })
        }}
      >
        <ChevronDownIcon />
      </button>
      {at && (
        <ContextMenu at={at} align="end" above trigger={arrow.current} label={t('ChatPlan.executionPermissions')} onClose={close}>
          {modes.map((each) => (
            <button
              key={each}
              type="button"
              role="menuitemradio"
              aria-checked={each === mode}
              className="menu-item plan-run-mode"
              onClick={() => {
                setPreference('planRunMode', each)
                close()
              }}
            >
              <span className="plan-run-mode-text">
                <span className="menu-item-title">{agentDescriptor(agent, getLocale()).nativePlanRun ? modeLabel(agent, each) : RUN_MODE[each].label}</span>
                <span className="menu-item-path">{agentDescriptor(agent, getLocale()).nativePlanRun?.hint ?? RUN_MODE[each].hint}</span>
              </span>
              {each === mode && <span className="menu-check"><CheckIcon /></span>}
            </button>
          ))}
        </ContextMenu>
      )}
    </span>
  )
}

export function ChatPlanLine({ item }: { item: PlanItem }) {
  const surface = useChatSurface()
  const waiting = item.resolution === null
  const note = surface.planNote(item)
  return (
    <button type="button" className="chat-request-line chat-plan-line" data-waiting={waiting || undefined} onClick={() => surface.showPlan(itemKey(item))}>
      {waiting ? t('ChatPlan.planAwaitingApprovalViewOnTheRightRespond') : t('ChatPlan.planView', { value1: note ?? status(item) })}
    </button>
  )
}

// In the composer's place while the plan waits: the plan itself, clipped until opened, then the
// answers as numbered rows like any approval's. Carry it out, in the permission mode the execute
// button picks, or send it back with a note; where the chat may only plan, keep it for later
// instead. An older core carries a plan out only asking about edits or accepting them. Or stop:
// the turn ends with nothing carried out and nothing replanned, and the next word is the user's.
type PlanChoice = 'run' | 'allow' | 'allowForSession' | 'squad' | 'save' | 'revise' | 'stop'
const CHOICE_LABEL: Record<Exclude<PlanChoice, 'revise' | 'squad'>, string> = localized(() => ({
  run: t('ChatPlan.implementPlan_396'),
  allow: t('ChatPlan.implementPlanAskBeforeEditingFilesOrRunning'),
  allowForSession: t('ChatPlan.implementPlanAcceptFileEditsAutomatically'),
  save: t('ChatPlan.savePlanFirstExecuteAfterDependenciesFinish'),
  stop: t('ChatPlan.stopWithoutExecuting')
}))
const SUBMIT_LABEL: Record<PlanChoice, string> = localized(() => ({ run: t('ChatPlan.execute'), allow: t('ChatPlan.execute'), allowForSession: t('ChatPlan.execute'), squad: t('ChatPlan.startSquadDevelopment'), save: t('ChatPlan.savePlan'), revise: t('ChatPlan.continuePlanning'), stop: t('ChatPlan.stop') }))
const PREVIEW_LINES = 12

export function ChatPlanCard({ conversationId, item, modes }: { conversationId: string; item: PlanItem; modes: readonly string[] }) {
  const surface = useChatSurface()
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const { savePlan, squadStart } = surface
  // Not in a routine's chat, whose follow-ups nobody is told of (ChatComposer).
  const routine = useCore((s) => Boolean(s.conversations[conversationId]?.routineId || s.conversations[conversationId]?.helperOf))
  const agent = useCore((s) => s.conversations[conversationId]?.agent ?? 'claude')
  const schedulable = useSchedulesSupported() && agentDescriptor(agent).capabilities.unattended && !savePlan && !routine
  const runModes = RUN_MODES.filter((mode) => (item.runModes ?? modes).includes(mode))
  const picked = usePreferences((s) => s.planRunMode)
  const runMode: RunMode = runModes.includes(picked) ? picked : runModes.includes('auto') ? 'auto' : runModes[0] ?? 'ask'
  const modesSupported = usePlanModesSupported() && runModes.length > 0
  const choices: PlanChoice[] = squadStart ? (savePlan ? ['squad', 'save', 'revise', 'stop'] : ['squad', 'revise', 'stop']) : savePlan ? ['save', 'revise', 'stop'] : modesSupported ? ['run', 'revise', 'stop'] : ['allow', 'allowForSession', 'revise', 'stop']
  const [choice, setChoice] = useState<PlanChoice>(choices[0] ?? 'revise')
  const noteInput = useRef<HTMLInputElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const long = (item.detail ?? '').split('\n').length > PREVIEW_LINES
  // The inspector beside the chat already shows this plan in full: no second copy here.
  const key = itemKey(item)
  const inView = useCore((s) => surface.inspector === 'task'
    ? s.inspectorOpen && s.taskInspectorTab === 'plan' && (s.taskInspectorPlan === null || s.taskInspectorPlan === key)
    : s.conversationInspectorOpen && s.conversationInspectorTab === 'plan' && (s.conversationPlan === null || s.conversationPlan === key))
  // Comments made on the plan, and passages quoted from the chat, go back with it to keep planning.
  const quotes = useQuotes(conversationId)
  const commented = quotes.length > 0
  useEffect(() => {
    if (commented) setChoice('revise')
  }, [commented, quotes.length])
  // Ends the turn: what waits is turned down on the way, so the plan reads as not carried out.
  const stop = async () => {
    setSaving(true)
    await perform((rpc) => rpc.call('conversations.interrupt', { id: conversationId }))
    setSaving(false)
  }
  const submit = async () => {
    if (busy || saving) return
    if (choice === 'stop') {
      await stop()
    } else if (choice === 'squad') {
      if (!squadStart) return
      setSaving(true)
      await squadStart.start(item)
      setSaving(false)
    } else if (choice === 'save') {
      if (!savePlan) return
      setSaving(true)
      await savePlan(item)
      setSaving(false)
    } else if (choice === 'revise') {
      const message = commented ? composeFeedback(quotes, note) : note.trim()
      if (await respond('deny', message ? { message } : {}) && commented) setQuotes(conversationId, [])
    } else if (choice === 'run') {
      // The decision too, for what reads only that: asking is allow, anything freer goes ahead.
      await respond(runMode === 'ask' ? 'allow' : 'allowForSession', { mode: runMode })
    } else {
      await respond(choice)
    }
  }
  const pick = (next: PlanChoice) => {
    setChoice(next)
    if (next === 'revise') noteInput.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy && !saving) void stop()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (/^[1-9]$/.test(event.key) && !(event.target instanceof HTMLInputElement)) {
      const next = choices[Number(event.key) - 1]
      if (next) {
        event.preventDefault()
        pick(next)
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const at = choices.indexOf(choice)
      const next = choices[(at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]
      if (next) pick(next)
      if (next !== 'revise') noteInput.current?.blur()
    }
  }
  return (
    <div className="chat-request chat-plan" data-waiting onKeyDown={onKeyDown}>
      <div className="chat-request-title">{tr('ChatPlan.planAwaitingYourApproval', { value1: inView
          ? <span className="chat-plan-aside">{t('ChatPlan.fullPlanOnTheRight')}</span>
          : <button type="button" className="link-button" onClick={() => surface.showPlan(key)}>{t('ChatPlan.viewFullPlanInInspector')}</button>, value2: surface.handoffPlan && <button type="button" className="link-button" disabled={busy || saving} onClick={() => surface.handoffPlan?.(item)}>{t('ChatPlan.assignToSquad')}</button>, value3: schedulable && <SchedulePlanButton conversationId={conversationId} />, value4: null })}</div>
      {squadStart
        ? <p className="chat-request-detail muted">{tr('ChatPlan.afterApprovalTheLeaderAssignsWorkToMembers', { value1: squadStart.name })}</p>
        : savePlan && <p className="chat-request-detail muted">{t('ChatPlan.dependenciesAreUnfinishedSaveThePlanNowThen')}</p>}
      {item.detail && !inView && (
        <div className="chat-plan-preview" ref={preview} data-clipped={(long && !open) || undefined}>
          <ChatMarkdown text={item.detail} />
          {long && (
            <button type="button" className="link-button chat-plan-preview-more" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? t('ChatPlan.collapse') : t('ChatPlan.expandAll')}
            </button>
          )}
        </div>
      )}
      {commented && <QuoteCards conversationId={conversationId} quotes={quotes} onDone={() => noteInput.current?.focus()} />}
      <div className="chat-approve-options" role="radiogroup" aria-label={t('ChatPlan.howToRespond')}>
        {choices.map((each, index) => (
          <div
            key={each}
            role="radio"
            tabIndex={each === 'revise' ? -1 : 0}
            aria-checked={choice === each}
            className="chat-approve-option"
            onClick={() => pick(each)}
          >
            <span className="chat-approve-number">{index + 1}.</span>
            {each === 'revise' ? (
              <input
                ref={noteInput}
                className="chat-approve-reason"
                aria-label={t('ChatPlan.continuePlanningTellAgentWhatToChange')}
                placeholder={commented ? t('ChatPlan.continuePlanningWithCommentsAddMoreIfNeeded', { value1: quotes.length }) : t('ChatPlan.continuePlanningTellAgentWhatToChangeOptional')}
                value={note}
                disabled={busy || saving}
                onFocus={() => setChoice('revise')}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setNote(event.target.value)}
              />
            ) : (
              <span>{each === 'squad' ? t('ChatPlan.assignPlanTo', { value1: squadStart?.name ?? t('ChatPlan.squad') }) : each === 'save' && squadStart ? t('ChatPlan.savePlanFirstAssignToSquadLater') : CHOICE_LABEL[each]}</span>
            )}
          </div>
        ))}
      </div>
      <div className="chat-approve-footer">
        <span className="chat-approve-hint">{t('ChatPlan.numberKeysToSelectEnterToSubmitEsc')}</span>
        {choice === 'run'
          ? <RunModeButton modes={runModes} mode={runMode} disabled={busy || saving} onRun={() => void submit()} agent={agent} />
          : (
            <button type="button" className="button primary" disabled={busy || saving} onClick={() => void submit()}>
              {SUBMIT_LABEL[choice]}<kbd>↵</kbd>
            </button>
          )}
      </div>
    </div>
  )
}

// A plan's translation, apart from a reply's under the same conversation.
function planTranslationKey(key: string): string {
  return `plan:${key}`
}

function downloadMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function PlanMarkdownActions({ markdown, filename }: { markdown: string; filename: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span className="chat-plan-view-actions">
      <button
        type="button"
        className="tool-button"
        data-copied={copied || undefined}
        aria-label={copied ? t('BranchStatus.copied') : t('ChatPlan.copyMarkdown')}
        data-tooltip={copied ? t('BranchStatus.copied') : t('ChatPlan.copyMarkdown')}
        onClick={() => void navigator.clipboard.writeText(markdown).then(() => setCopied(true), () => {})}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button type="button" className="tool-button" aria-label={t('ChatPlan.downloadMarkdown')} data-tooltip={t('ChatPlan.downloadMarkdown')} onClick={() => downloadMarkdown(filename, markdown)}>
        <DownloadIcon />
      </button>
    </span>
  )
}

// The inspector's plan tab: the newest plan, or an earlier version the user picked. It shows beside
// the chat rather than in it, so it is told how to pick a version and what its owner kept.
// Text selected in it takes a comment, where the chat it belongs to is known.
export function ChatPlanView({ conversationId, plans, selected, onSelect, note = () => null }: {
  conversationId: string | null
  plans: readonly PlanItem[]
  selected: string | null
  onSelect: (key: string) => void
  note?: (item: PlanItem) => string | null
}) {
  const body = useRef<HTMLDivElement>(null)
  const quotes = useQuotes(conversationId ?? '')
  const plan = plans.find((each) => itemKey(each) === selected) ?? plans.at(-1)
  const said = (each: PlanItem) => note(each) ?? status(each)
  if (!plan) return <p className="inspector-empty muted">{t('ChatPlan.agentHasNotProposedAPlanYet')}</p>
  const planKey = itemKey(plan)
  const comments = quotes.filter((quote) => quote.source === planKey).length
  const version = plans.indexOf(plan) + 1
  return (
    <div className="chat-plan-view">
      <div className="chat-plan-view-status" data-waiting={plan.resolution === null || undefined}>
        <div className="chat-plan-view-status-text">
          {plans.length > 1 ? (
            <ChatPicker
              label={t('ChatPlan.planVersions')}
              value={itemKey(plan)}
              placeholder={t('ChatPlan.version', { version: version })}
              placement="below"
              options={plans.map((each, index) => ({ value: itemKey(each), label: t('ChatPlan.version_427', { value1: index + 1, value2: said(each) }) }))}
              onChange={onSelect}
            />
          ) : said(plan)}
          {plan.resolution === null && <span className="muted">{t('ChatPlan.confirmBelowTheChat')}</span>}
        </div>
        {plan.detail && <PlanMarkdownActions markdown={plan.detail} filename={planMarkdownFilename(plan.detail, version, plans.length)} />}
      </div>
      {conversationId && plan.detail && comments > 0 && (
        <p className="chat-plan-view-hint">{tr('ChatPlan.comments', { comments: comments, value2: plan.resolution === null ? t('ChatPlan.chooseContinuePlanningBelowToSendThemTo') : t('ChatPlan.inTheComposerSendThemSoAgentCan') })}</p>
      )}
      {plan.detail
        ? <div className="chat-plan-body" ref={body}><ChatMarkdown text={plan.detail} /></div>
        : <p className="muted">{t('ChatPlan.thisPlanIsEmpty')}</p>}
      {conversationId && plan.detail && <PlanComments conversationId={conversationId} planKey={planKey} body={body} />}
    </div>
  )
}
