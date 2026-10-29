import { getLocale, t, tr } from '../i18n'
import { useEffect, useMemo, type RefObject } from 'react'
import { useCore, useTranslateSupported } from '../core-store'
import { usePreferences } from '../preferences'
import { needsTranslation, showOriginal, translate, translationKey, useTranslations, type TranslationState } from '../translation'
import { TranslateIcon } from './icons'
import { Spinner } from './Spinner'

export type Translated = {
  // In another language than the user's, so there is something to translate.
  foreign: boolean
  result: TranslationState | undefined
  original: boolean
  // What to show: the translation, unless the user turned back to the original.
  shown: string
  translate: () => void
  toggle: () => void
}

// A passage of a conversation's (a reply, a plan) put into the user's language by the agent's small
// model, on request or, with translation on, once `box` comes into view, so opening a long
// conversation does not translate all of it. `key` names the passage within the conversation; the
// same key shares one translation wherever the passage shows. `ready`: the passage is complete.
export function useTranslated(conversationId: string | null, key: string, text: string, ready: boolean, box: RefObject<HTMLElement | null>): Translated {
  const supported = useTranslateSupported()
  const to = usePreferences((p) => p.translateTo)
  const auto = usePreferences((p) => p.autoTranslate)
  const agent = useCore((s) => (conversationId ? s.conversations[conversationId]?.agent : undefined))
  const model = usePreferences((p) => (agent ? p.quickModels[agent] : undefined)) ?? ''
  const foreign = useMemo(() => conversationId !== null && supported && ready && text !== '' && needsTranslation(text, to), [conversationId, supported, ready, text, to, getLocale()])
  const id = conversationId ? translationKey(conversationId, key, to, model) : ''
  const result = useTranslations((s) => s.results[id])
  const original = useTranslations((s) => s.original[id] ?? false)
  useEffect(() => {
    const element = box.current
    if (!foreign || !auto || result || !element || !conversationId) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void translate(conversationId, id, text, to, model)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [foreign, auto, result, conversationId, id, text, to, model, box])
  return {
    foreign,
    result,
    original,
    shown: result?.state === 'done' && !original ? result.text : text,
    translate: () => {
      if (!conversationId) return
      showOriginal(id, false)
      void translate(conversationId, id, text, to, model)
    },
    toggle: () => showOriginal(id, !original)
  }
}

// Asks for the translation, then turns between it and the original. `what`: what is translated,
// for the tooltip ("这条回复").
export function TranslateButton({ translated, what }: { translated: Translated; what: string }) {
  const { result: state, original } = translated
  if (state?.state === 'pending') return <span className="chat-translate" role="status">{tr('ChatContextMenu.translating', { value1: <Spinner /> })}</span>
  if (state?.state === 'done') {
    const by = state.model ? t('TranslateButton.translatedBy', { value1: state.model }) : t('TranslateButton.translatedByThisAgentSDefaultModel')
    return (
      <button type="button" className="copy-button chat-translate" data-tooltip={original ? t('TranslateButton.viewTranslation', { by: by }) : t('TranslateButton.viewOriginalTranslationBy', { by: by })} onClick={translated.toggle}>
        <TranslateIcon />{original ? t('SettingsPage.translation') : t('SettingsPage.original')}
      </button>
    )
  }
  return (
    <button type="button" className="copy-button chat-translate" data-failed={state?.state === 'failed' || undefined} data-tooltip={state?.state === 'failed' ? t('TranslateButton.clickToRetry', { value1: state.error }) : t('TranslateButton.translateUsingThisAgentSSmallModel', { what: what })} onClick={translated.translate}>
      <TranslateIcon />{state?.state === 'failed' ? t('TranslateButton.retryTranslation') : t('ChatContextMenu.translate')}
    </button>
  )
}
