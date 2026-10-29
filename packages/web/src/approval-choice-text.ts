import { localized, t } from './i18n'
import type { ApprovalChoice, ApprovalGrant, ApprovalScope, ChatItem } from '@conclave/protocol'
import { modeLabel } from './components/ChatOptionsBar'

type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>

// How long, and where, what an answer remembers holds: said before what it is.
const SCOPE_LEAD: Record<ApprovalScope, string> = localized(() => ({
  run: t('approvalChoiceText.thisRun'),
  local: t('approvalChoiceText.futureRunsInThisProject'),
  project: t('approvalChoiceText.futureRunsInThisProject'),
  user: t('approvalChoiceText.futureRunsInAllProjects'),
  agent: t('approvalChoiceText.futureRuns')
}))
// Where it is kept, so the user knows what else it reaches and where to take it back.
const SCOPE_NOTE: Record<ApprovalScope, string> = localized(() => ({
  run: t('approvalChoiceText.expiresWhenTheAgentStopsOrRestarts'),
  local: t('approvalChoiceText.savedToThisProjectSClaudeSettingsLocal'),
  project: t('approvalChoiceText.savedToThisProjectSClaudeSettingsJson'),
  user: t('approvalChoiceText.savedToClaudeSettingsJsonForAllProjects'),
  agent: t('approvalChoiceText.savedInTheAgentSRulesIncludingFuture')
}))
const SHOWN = 3

function listed(values: readonly string[]): string {
  const shown = values.slice(0, SHOWN).join('、')
  return values.length > SHOWN ? t('approvalChoiceText.andItemsInTotal', { shown: shown, value2: values.length }) : shown
}

function grantAction(grant: ApprovalGrant): string {
  const what = listed(grant.values)
  switch (grant.kind) {
    case 'rules': {
      // Command prefixes, as Conclave writes them for Bash, read as Codex's do: what they start with.
      const prefixes = grant.values.map((value) => /^Bash\((.+?)(?::\*| \*)\)$/.exec(value)?.[1])
      if (grant.behavior === 'allow' && prefixes.every((prefix) => prefix !== undefined)) return t('approvalChoiceText.donTAskForCommandsStartingWith', { value1: listed(prefixes.map(String)) })
      return grant.behavior === 'deny' ? t('approvalChoiceText.neverAllow', { what: what }) : grant.behavior === 'ask' ? t('approvalChoiceText.alwaysAskBefore', { what: what }) : t('approvalChoiceText.donTAskBefore', { what: what })
    }
    // Only Claude suggests switching mode.
    case 'mode':
      return t('approvalChoiceText.switchToMode', { value1: modeLabel('claude', grant.values[0] ?? '') })
    case 'directories':
      return t('approvalChoiceText.donTAskToAccess', { what: what })
    case 'command':
      return t('approvalChoiceText.donTAskForThisCommand')
    case 'files':
      return what ? t('approvalChoiceText.donTAskToEdit', { what: what }) : t('approvalChoiceText.donTAskToEditTheseFiles')
    case 'prefix':
      return t('approvalChoiceText.donTAskForCommandsStartingWith', { value1: grant.values.join(' ') })
    case 'host':
      return grant.behavior === 'deny' ? t('approvalChoiceText.neverAllowAccessTo', { what: what }) : t('approvalChoiceText.donTAskToAccess', { what: what })
    case 'other':
      return t('approvalChoiceText.additionalRulesSuggestedByTheAgent')
  }
}

// What a choice remembers, scope by scope in the order the agent gave them.
function grantsText(grants: readonly ApprovalGrant[]): string {
  const scopes = [...new Set(grants.map((grant) => grant.scope))]
  return scopes.map((scope) => {
    const actions = grants.filter((grant) => grant.scope === scope).map(grantAction).join('，')
    // A space between Chinese and a rule or path that follows it.
    return `${SCOPE_LEAD[scope]}${/^[!-~]/.test(actions) ? ' ' : ''}${actions}`
  }).join('；')
}

// A choice's row: what it does, and where what it remembers is kept. A plain deny has its own row.
export function choiceText(choice: ApprovalChoice): { label: string; note: string | null } {
  if (choice.label) return { label: choice.label, note: choice.grants.length ? [...new Set(choice.grants.map((grant) => SCOPE_NOTE[grant.scope]))].join('；') : null }
  if (choice.grants.length === 0) return { label: choice.decision === 'deny' ? t('approvalChoiceText.deny') : t('approvalChoiceText.allowOnce'), note: null }
  const notes = [...new Set(choice.grants.map((grant) => SCOPE_NOTE[grant.scope]))]
  return { label: `${choice.decision === 'deny' ? t('approvalChoiceText.deny') : t('approvalChoiceText.allow')}，${grantsText(choice.grants)}`, note: notes.join('；') }
}

// The submit button's words for a choice: short, the row above says the rest.
export function choiceAction(choice: ApprovalChoice): string {
  if (choice.grants.length === 0) return choice.decision === 'deny' ? t('approvalChoiceText.deny') : t('approvalChoiceText.allow')
  return choice.decision === 'deny' ? t('approvalChoiceText.denyAndRemember') : t('approvalChoiceText.allowAndRemember')
}

// Whether a choice is the plain no, whose row takes the reason for it.
export function isPlainDeny(choice: ApprovalChoice): boolean {
  return choice.decision === 'deny' && choice.grants.length === 0
}

// How an answered approval went, when it was answered with a choice that remembered something.
export function chosenText(item: ApprovalItem): string | null {
  const choice = item.chosen ? item.choices?.find((each) => each.id === item.chosen) : undefined
  if (!choice) return null
  if (choice.label) return `${choice.decision === 'deny' ? t('approvalChoiceText.denied') : t('approvalChoiceText.allowed')} · ${choice.label}`
  if (choice.grants.length === 0) return null
  return `${choice.decision === 'deny' ? t('approvalChoiceText.denied') : t('approvalChoiceText.allowed')}，${grantsText(choice.grants)}`
}
