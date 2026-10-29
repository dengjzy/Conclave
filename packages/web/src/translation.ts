import { t } from './i18n'
import { RpcError, type TranslateLanguage, type Translation } from '@conclave/protocol'
import { create } from 'zustand'
import { useCore } from './core-store'
import { reasonText } from './labels'

// What a reply is mostly written in, by its letters: Han characters, Japanese kana, Hangul, or Latin
// words. Code, paths and links say nothing of the language, so they are left out.
function scripts(text: string): { han: number; kana: number; hangul: number; latin: number } {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:~|\.{1,2})?\/[\w./-]+/g, ' ')
  return {
    han: prose.match(/\p{Script=Han}/gu)?.length ?? 0,
    kana: prose.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0,
    hangul: prose.match(/\p{Script=Hangul}/gu)?.length ?? 0,
    // A word, not a letter, weighs as much as a Han character does.
    latin: prose.match(/[A-Za-z]{2,}/g)?.length ?? 0
  }
}

// Whether a reply is in another language than the one asked for; too little prose to tell is not.
export function needsTranslation(text: string, to: TranslateLanguage): boolean {
  const { han, kana, hangul, latin } = scripts(text)
  const total = han + kana + hangul + latin
  if (total < 8) return false
  switch (to) {
    case 'zh-CN':
    case 'zh-TW':
      return (han - kana) / total < 0.5 || kana / total > 0.1
    case 'ja':
      return kana / total < 0.05
    case 'ko':
      return hangul / total < 0.3
    case 'en':
      return latin / total < 0.6
  }
}

export type TranslationState =
  | { state: 'pending' }
  | ({ state: 'done' } & Translation)
  | { state: 'failed'; error: string }

// Translations by reply and language, for as long as the window is open; which of them the user
// turned back to the original.
export const useTranslations = create<{ results: Record<string, TranslationState>; original: Record<string, boolean> }>()(() => ({ results: {}, original: {} }))

// A reply into a language with a model ('' for the agent's cheapest): a translation of its own.
export function translationKey(conversationId: string, itemKey: string, to: TranslateLanguage, model: string): string {
  return `${conversationId}\n${itemKey}\n${to}\n${model}`
}

export async function translate(conversationId: string, key: string, text: string, to: TranslateLanguage, model: string): Promise<void> {
  const current = useTranslations.getState().results[key]
  if (current?.state === 'pending' || current?.state === 'done') return
  const set = (state: TranslationState) => useTranslations.setState((all) => ({ results: { ...all.results, [key]: state } }))
  // A failure stays on the reply it was for, rather than in the window's error bar: with
  // translation on, a few may fail at once.
  const { rpc } = useCore.getState()
  if (!rpc) return set({ state: 'failed', error: t('coreStore.notConnectedToConclaveCore') })
  set({ state: 'pending' })
  try {
    set({ state: 'done', ...(await rpc.call('conversations.translate', { id: conversationId, text, to, ...(model ? { model } : {}) })) })
  } catch (error) {
    set({ state: 'failed', error: error instanceof RpcError && error.reason ? reasonText(error.reason, error.message) : error instanceof Error ? error.message : String(error) })
  }
}

export function showOriginal(key: string, original: boolean): void {
  useTranslations.setState((all) => ({ original: { ...all.original, [key]: original } }))
}
