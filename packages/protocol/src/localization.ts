import { z } from 'zod'

export const UiLocale = z.enum(['zh-CN', 'en'])
export type UiLocale = z.infer<typeof UiLocale>
export const LanguagePreference = z.enum(['system', 'zh-CN', 'en'])
export type LanguagePreference = z.infer<typeof LanguagePreference>

// Original strings remain the fallback for older clients and untranslated providers.
export const TextTranslations = z.object({
  en: z.object({
    label: z.string().optional(),
    hint: z.string().optional(),
    placeholder: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional()
  }).optional()
})
export type TextTranslations = z.infer<typeof TextTranslations>

export function translatedText<T extends { translations?: TextTranslations }>(value: T, locale: UiLocale): T {
  return locale === 'en' ? { ...value, ...value.translations?.en } : value
}

export function resolveUiLocale(preference: LanguagePreference, languages: readonly string[] = []): UiLocale {
  if (preference !== 'system') return preference
  return /^zh(?:-|$)/i.test(languages[0] ?? '') ? 'zh-CN' : 'en'
}
