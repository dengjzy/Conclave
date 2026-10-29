import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => {
  const stored = new Map<string, string>()
  const listeners = new Map<string, Array<(event: { key?: string }) => void>>()
  const setLanguage = vi.fn(async () => {})
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  const languages = ['en-US']
  vi.stubGlobal('navigator', { languages })
  vi.stubGlobal('document', { documentElement: { lang: '' } })
  vi.stubGlobal('window', {
    conclave: { setLanguage },
    addEventListener: (event: string, callback: (event: { key?: string }) => void) => listeners.set(event, [...(listeners.get(event) ?? []), callback]),
    removeEventListener: (event: string, callback: (event: { key?: string }) => void) => listeners.set(event, (listeners.get(event) ?? []).filter((known) => known !== callback))
  })
  return { stored, listeners, setLanguage, languages }
})

import { startUiLanguage } from './language'
import { DEFAULT_PREFERENCES, followPreferences, setPreference, usePreferences } from './preferences'
import { getLocale, setLocale } from './i18n'

let stop = () => {}
beforeEach(() => {
  usePreferences.setState(DEFAULT_PREFERENCES, true)
  setLocale('zh-CN')
  environment.stored.clear()
  environment.listeners.clear()
  environment.setLanguage.mockClear()
  environment.languages[0] = 'en-US'
})
afterEach(() => { stop(); setLocale('zh-CN') })

describe('desktop language preference', () => {
  it('resolves system language, applies the document language, and informs native main', () => {
    stop = startUiLanguage()
    expect(getLocale()).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(environment.setLanguage).toHaveBeenLastCalledWith('zh-CN')
    setPreference('language', 'zh-CN')
    expect(getLocale()).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(JSON.parse(environment.stored.get('conclave.preferences') ?? '{}').language).toBe('zh-CN')
    expect(usePreferences.getState().translateTo).toBe('zh-CN')
    expect(usePreferences.getState().autoTranslate).toBe(false)
  })

  it('responds to system changes only when following the system', () => {
    stop = startUiLanguage()
    environment.languages[0] = 'zh-TW'
    for (const listener of environment.listeners.get('languagechange') ?? []) listener({})
    expect(getLocale()).toBe('zh-CN')
    setPreference('language', 'en')
    for (const listener of environment.listeners.get('languagechange') ?? []) listener({})
    expect(getLocale()).toBe('en')
    stop()
    expect(environment.listeners.get('languagechange')).toEqual([])
  })

  it('follows another window without resetting other preferences or translation settings', () => {
    stop = startUiLanguage()
    followPreferences()
    environment.stored.set('conclave.preferences', JSON.stringify({ ...DEFAULT_PREFERENCES, language: 'zh-CN', theme: 'dark', translateTo: 'ja' }))
    for (const listener of environment.listeners.get('storage') ?? []) listener({ key: 'conclave.preferences' })
    expect(getLocale()).toBe('zh-CN')
    expect(usePreferences.getState()).toMatchObject({ language: 'zh-CN', theme: 'dark', translateTo: 'ja' })
  })

  it('loads old and invalid language values as system, preserving existing preferences', () => {
    stop = startUiLanguage()
    followPreferences()
    for (const saved of [{ theme: 'dark' }, { theme: 'dark', language: 'fr' }]) {
      environment.stored.set('conclave.preferences', JSON.stringify(saved))
      for (const listener of environment.listeners.get('storage') ?? []) listener({ key: 'conclave.preferences' })
      expect(usePreferences.getState()).toMatchObject({ language: 'zh-CN', theme: 'dark' })
      expect(getLocale()).toBe('zh-CN')
    }
  })
})
