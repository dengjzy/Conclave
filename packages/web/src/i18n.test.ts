import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { MESSAGES } from './shared/messages'
import { getLocale, localized, messageSearchText, setLocale, t, tr, useLocale } from './i18n'
import { STATUS_LABEL, chatDayAndTime, reasonText } from './labels'
import { compact } from './stat-format'
import { mentionedMembers } from './discussions'
import { ROUTINE_TEMPLATES } from './routine-templates'

const PLURAL = /\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g
const fields = (text: string) => [...new Set([...text.replace(PLURAL, '{$1}').matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort()
afterEach(() => setLocale('zh-CN'))

describe('message catalog', () => {
  it('has complete English text with the same parameters for every Chinese entry', () => {
    for (const [key, text] of Object.entries(MESSAGES)) {
      expect(text.zh.length, key).toBeGreaterThan(0)
      expect(text.en.length, key).toBeGreaterThan(0)
      expect(text.en, key).not.toMatch(/\p{Script=Han}/u)
      expect(fields(text.en), key).toEqual(fields(text.zh))
    }
  })

  it('formats English singular and plural forms, including zero', () => {
    setLocale('en')
    expect(t('chatTools.readFiles', { count: 1 })).toBe('Read 1 file')
    expect(t('chatTools.readFiles', { count: 2 })).toBe('Read 2 files')
    expect(t('chatTools.readFiles', { count: 0 })).toBe('Read 0 files')
    setLocale('zh-CN')
    expect(t('chatTools.readFiles', { count: 1 })).toBe('读取 1 个文件')
  })

  it('keeps user values literal and escapes rich text without parsing HTML', () => {
    setLocale('en')
    const user = '中文 <script>{label}</script>'
    expect(t('ConversationActions.actionsForConversation', { value1: user })).toBe(`Actions for conversation “${user}”`)
    const rich = tr('ChatCommandSettings.save', { value1: createElement('kbd', null, '<Enter>') })
    expect(renderToStaticMarkup(createElement('button', null, rich))).toBe('<button>Save<kbd>&lt;Enter&gt;</kbd></button>')
  })
})

describe('live language changes', () => {
  it('updates presentation maps and arrays without changing their identity', () => {
    const table = localized(() => ({ pending: t('labels.pending') }))
    const list = localized(() => [t('labels.pending')])
    const tableReference = table
    expect(table.pending).toBe('未执行')
    setLocale('en')
    expect(table).toBe(tableReference)
    expect(Object.entries(table)).toEqual([['pending', 'Pending']])
    expect([...list]).toEqual(['Pending'])
    expect(STATUS_LABEL.pending).toBe('Pending')
    setLocale('zh-CN')
    expect(list[0]).toBe('未执行')
  })

  it('notifies subscribers once per effective language change', () => {
    const seen: string[] = []
    const stop = useLocale.subscribe((state) => seen.push(state.locale))
    setLocale('en')
    setLocale('en')
    setLocale('zh-CN')
    stop()
    expect(seen).toEqual(['en', 'zh-CN'])
    expect(getLocale()).toBe('zh-CN')
  })

  it('localizes errors, dates, numbers, and search while keeping unknown details intact', () => {
    setLocale('en')
    expect(reasonText('missing-repo', 'internal')).toBe('Add a project first')
    expect(reasonText('unknown', '外部 {detail}')).toBe('外部 {detail}')
    const now = new Date(2026, 9, 20, 12).getTime()
    expect(chatDayAndTime(new Date(2025, 9, 19, 9, 5).getTime(), now)).toBe('Oct 19, 2025 09:05')
    expect(compact(10000)).toBe('10K')
    expect(messageSearchText('Appearance')).toContain('外观')
    expect(messageSearchText('外观')).toContain('Appearance')
  })

  it('accepts mentions from either language and keeps template instructions independent', () => {
    const members = [{ id: 'a', name: 'Member A' }, { id: 'b', name: 'Member B' }]
    const instructions = ROUTINE_TEMPLATES.map((template) => template.text)
    setLocale('en')
    expect(mentionedMembers('@everyone please answer', members)).toEqual(['a', 'b'])
    expect(mentionedMembers('@所有人 请回答', members)).toEqual(['a', 'b'])
    expect(ROUTINE_TEMPLATES[0]?.title).toBe('Daily code review')
    expect(ROUTINE_TEMPLATES.map((template) => template.text)).toEqual(instructions)
  })
})
