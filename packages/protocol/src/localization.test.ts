import { describe, expect, it } from 'vitest'
import { LanguagePreference, resolveUiLocale, translatedText } from './localization'
import { LoginNotice, LoginPrompt, SettingField } from './source'
import { agentDescriptor, agentModeText } from './agents'

describe('interface locale', () => {
  it('uses simplified Chinese for Chinese systems and English for other systems', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'ZH-hant-HK']) expect(resolveUiLocale('system', [tag])).toBe('zh-CN')
    for (const tag of ['en-US', 'en-GB', 'ja-JP', 'de-DE']) expect(resolveUiLocale('system', [tag])).toBe('en')
    expect(resolveUiLocale('system', [])).toBe('en')
    expect(resolveUiLocale('system', ['en-US', 'zh-CN'])).toBe('en')
  })

  it('honors a manual language and accepts old or invalid preference values through the default', () => {
    expect(resolveUiLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveUiLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(LanguagePreference.catch('system').parse(undefined)).toBe('system')
    expect(LanguagePreference.catch('system').parse('fr')).toBe('system')
  })
})

describe('provider presentation compatibility', () => {
  it('keeps old source fields unchanged and overlays only available English text', () => {
    const original = SettingField.parse({ key: 'query', type: 'text', label: '筛选', hint: '说明', required: true })
    expect(translatedText(original, 'en')).toEqual(original)
    const bilingual = SettingField.parse({ ...original, translations: { en: { label: 'Filter' } } })
    expect(translatedText(bilingual, 'en')).toMatchObject({ label: 'Filter', hint: '说明', key: 'query', required: true })
    expect(translatedText(bilingual, 'zh-CN')).toBe(bilingual)
  })

  it('carries sign-in prompts, choices, links, retry errors, and notices without changing values', () => {
    const prompt = LoginPrompt.parse({ kind: 'select', label: '选择', error: '错误', translations: { en: { label: 'Choose', error: 'Try again' } }, options: [{ value: 'value', label: '选项', translations: { en: { label: 'Option' } } }], link: { url: 'https://example.com', label: '链接', translations: { en: { label: 'Link' } } } })
    expect(translatedText(prompt, 'en')).toMatchObject({ label: 'Choose', error: 'Try again' })
    expect(translatedText(prompt.options![0]!, 'en')).toMatchObject({ value: 'value', label: 'Option' })
    expect(translatedText(prompt.link!, 'en')).toMatchObject({ url: 'https://example.com', label: 'Link' })
    const notice = LoginNotice.parse({ message: '登录中', code: 'code', translations: { en: { message: 'Signing in' } } })
    expect(translatedText(notice, 'en')).toMatchObject({ message: 'Signing in', code: 'code' })
  })
})

describe('Agent presentation', () => {
  it('localizes text while preserving execution rules and native mode names', () => {
    for (const agent of ['claude', 'codex', 'cursor'] as const) {
      const zh = agentDescriptor(agent)
      const en = agentDescriptor(agent, 'en')
      expect(en.capabilities).toBe(zh.capabilities)
      expect(en.startModes).toBe(zh.startModes)
      expect(en.defaultStartMode).toBe(zh.defaultStartMode)
      expect(en.environment.role).not.toMatch(/\p{Script=Han}/u)
    }
    expect(agentModeText('codex', 'readOnly', 'en')?.label).toBe('Read only')
    expect(agentModeText('cursor', 'readOnly', 'en')?.label).toBe('Ask')
    expect(agentModeText('codex', 'unknown', 'en')).toBeUndefined()
  })
})
