import { describe, expect, it, vi } from 'vitest'
vi.mock('./core-store', () => ({ releaseIdleChats: vi.fn() }))
import { updateOffered } from './update-state'
import { UpdateState } from './shared/app-update'

describe('downloaded updates', () => {
  it('keeps a downloaded update visible until skipped and defaults automatic updates on', () => {
    const state = UpdateState.parse({ current: '0.20.1', status: 'ready', latest: { version: '0.20.2', notes: '', page: 'https://example.com', download: null }, canInstall: true, progress: null, error: null, blockers: [], checkedAt: null, prerelease: false, skipped: null })
    expect(state.automatic).toBe(true)
    expect(updateOffered(state)).toBe(true)
    expect(updateOffered({ ...state, skipped: '0.20.2' })).toBe(false)
  })
})
