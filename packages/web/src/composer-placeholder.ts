import { t } from './i18n'
import { PRIMARY_KEY_LABEL } from './shortcut-keys'

// What the input says while the agent works: what Enter does then, and, where the agent takes a
// message into the running turn, the key that puts it there (⌘ on a Mac, Ctrl+ elsewhere).
export function workingPlaceholder({ awaiting, queueable, steerable }: { awaiting: boolean; queueable: boolean; steerable: boolean }, primaryKey = PRIMARY_KEY_LABEL): string {
  if (!queueable) return awaiting ? t('composerPlaceholder.answerTheRequestAboveFirst') : t('composerPlaceholder.agentIsWorkingDraftTheNextMessageNow')
  return t('composerPlaceholder.draftAnotherMessageEnterQueuesItAfterThis', { value1: awaiting ? t('composerPlaceholder.answerTheRequestAboveFirst_2252') : '', value2: steerable ? t('composerPlaceholder.enterToInsertImmediately', { primaryKey: primaryKey }) : '' })
}
