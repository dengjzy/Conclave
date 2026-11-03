import { describe, expect, it, vi } from 'vitest'
import { appendDraft, composerDraft, EMPTY_DRAFT, saveComposerDraft, subscribeDraftAppend } from './composer-drafts'

describe('append to a conversation draft', () => {
  it('preserves existing input and images when the composer is not mounted', () => {
    saveComposerDraft('pull-test', { text: 'existing', mentions: [], images: [] })
    appendDraft('pull-test', 'PR data')
    expect(composerDraft('pull-test').text).toBe('existing\n\nPR data')
    saveComposerDraft('pull-test', EMPTY_DRAFT)
  })
  it('hands text to the live composer and unsubscribes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeDraftAppend('pull-test', listener)
    appendDraft('pull-test', 'one')
    expect(listener).toHaveBeenCalledWith('one')
    unsubscribe()
    appendDraft('pull-test', 'two')
    expect(composerDraft('pull-test').text).toBe('two')
    saveComposerDraft('pull-test', EMPTY_DRAFT)
  })
})
