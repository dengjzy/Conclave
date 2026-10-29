import { Fragment, createElement, isValidElement, type ReactNode } from 'react'
import { create } from 'zustand'
import { resolveUiLocale, type LanguagePreference, type UiLocale } from '@conclave/protocol'
import { MESSAGES } from './shared/messages'

export type MessageKey = keyof typeof MESSAGES
type Fields<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Fields<Rest> : never
type Values<K extends MessageKey> = Record<Fields<(typeof MESSAGES)[K]['zh']>, unknown>
type Args<K extends MessageKey> = Fields<(typeof MESSAGES)[K]['zh']> extends never ? [values?: Values<K>] : [values: Values<K>]

// Node-based tests and headless imports do not have a desktop language preference.
export const useLocale = create<{ locale: UiLocale }>()(() => ({ locale: 'zh-CN' }))
export const getLocale = (): UiLocale => useLocale.getState().locale
export function setLocale(locale: UiLocale): void {
  if (getLocale() !== locale) useLocale.setState({ locale })
}

const plurals = new Intl.PluralRules('en')
function message<K extends MessageKey>(key: K, values: Values<K> | undefined): string {
  const item = (MESSAGES as Record<string, { zh: string; en: string }>)[key]
  if (!item) {
    console.warn(`[i18n] Missing message key: "${String(key)}"`)
    return String(key)
  }
  const text = (getLocale() === 'en' ? item.en : item.zh) ?? item.zh ?? item.en ?? String(key)
  return text.replace(/\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g, (_match, name: string, one: string, other: string) =>
    plurals.select(Number(values && Reflect.get(values, name))) === 'one' ? one : other)
}

// Interpolate values once: user content containing braces is never interpreted as a message.
export function t<K extends MessageKey>(key: K, ...[values]: Args<K>): string {
  return message(key, values).replace(/\{(\w+)\}/g, (match, name: string) => values && Object.hasOwn(values, name) ? String(Reflect.get(values, name) ?? '') : match)
}

// Inline elements stay React nodes, so translation never parses content as HTML.
export function tr<K extends MessageKey>(key: K, ...[values]: Args<K>): ReactNode {
  return message(key, values).split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    const value = name && values && Object.hasOwn(values, name) ? reactValue(Reflect.get(values, name)) : part
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined ? value : createElement(Fragment, { key: name ?? index }, value)
  })
}
function reactValue(value: unknown): ReactNode {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (isValidElement(value)) return value
  if (Array.isArray(value)) return value.map(reactValue)
  return String(value)
}

// Presentation tables keep a stable identity, with one cached value for the selected language.
// This avoids freezing translated labels at module load or rebuilding arrays on every access.
export function localized<T extends object>(factory: () => T): T {
  let locale = getLocale()
  let value = factory()
  const read = (): T => {
    if (getLocale() !== locale) {
      locale = getLocale()
      value = factory()
    }
    return value
  }
  return new Proxy(value, { get: (_target, key) => Reflect.get(read(), key), getOwnPropertyDescriptor: (_target, key) => Object.getOwnPropertyDescriptor(read(), key) })
}

export function startLanguage(preference: LanguagePreference): void {
  setLocale(resolveUiLocale(preference, navigator.languages))
  document.documentElement.lang = getLocale()
  void window.conclave?.setLanguage?.(getLocale()).catch(() => {})
}

const SEARCH_TEXT = new Map<string, string>()
for (const { zh, en } of Object.values(MESSAGES)) {
  const text = `${zh} ${en}`
  SEARCH_TEXT.set(zh, text)
  SEARCH_TEXT.set(en, text)
}
export function messageSearchText(text: string): string {
  return SEARCH_TEXT.get(text) ?? text
}
