import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { Conversation } from '@conclave/protocol'
import { useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { translationKey, useTranslations } from '../translation'
import { SelectionTranslation } from './ChatContextMenu'

vi.hoisted(() => {
  vi.stubGlobal('window', { conclave: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

// Read the live store instead of Zustand's fixed SSR hydration snapshot.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

const id = '00000001-0000-4000-8000-000000000000'
const text = 'third-party sync'
const key = translationKey(id, `selection:${text}`, 'zh-CN', '')
const render = () => renderToStaticMarkup(createElement(SelectionTranslation, { conversationId: id, text, onClose: () => {} }))

beforeEach(() => {
  useCore.setState({ ...useCore.getInitialState(), conversations: { [id]: Conversation.parse({
    id, title: '会话', titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [], managedWorkspace: false, sessionId: null, createdAt: 0, updatedAt: 0
  }) } }, true)
  usePreferences.setState({ translateTo: 'zh-CN', quickModels: {} })
  useTranslations.setState({ results: {}, original: {} })
})

describe('translating a selection', () => {
  it('waits, then shows the translation with a copy of it, kept by the words selected', () => {
    useTranslations.setState({ results: { [key]: { state: 'pending' } }, original: {} })
    expect(render()).toContain('翻译中…')
    useTranslations.setState({ results: { [key]: { state: 'done', text: '三方同步', model: 'haiku' } }, original: {} })
    const html = render()
    expect(html).toContain('三方同步')
    expect(html).toContain('由 haiku 翻译')
    expect(html).toContain('复制译文')
  })

  it('says why it failed and offers to try again', () => {
    useTranslations.setState({ results: { [key]: { state: 'failed', error: '额度用完了' } }, original: {} })
    const html = render()
    expect(html).toContain('data-failed="true"')
    expect(html).toContain('额度用完了')
    expect(html).toContain('重试')
  })
})
