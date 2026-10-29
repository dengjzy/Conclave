import { z } from 'zod'
import type { ChatCatalog } from './chat'

// What a reply can be translated into, by its BCP 47 tag; the user picks one in the settings.
export const TRANSLATE_LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const
export const TranslateLanguage = z.enum(TRANSLATE_LANGUAGES)
export type TranslateLanguage = z.infer<typeof TranslateLanguage>

export const LANGUAGE_NAMES: Record<TranslateLanguage, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
}

// The first of an agent's cheap models (AgentDescriptor.quickModels) its catalog has, in the
// catalog's order; null leaves the agent's default.
export function quickModel(preferred: readonly RegExp[] | undefined, catalog: ChatCatalog | null | undefined): string | null {
  for (const pattern of preferred ?? []) {
    const found = catalog?.models.find((model) => pattern.test(model.id))
    if (found) return found.id
  }
  return null
}

// A reply in another language, and the model that put it there (null for the agent's default).
export const Translation = z.object({ text: z.string(), model: z.string().nullable() })
export type Translation = z.infer<typeof Translation>
