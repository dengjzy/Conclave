import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserMobilePlatform } from './mobile-platform'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('browser mobile platform', () => {
  it('keeps credentials and preferences in memory when storage is denied', async () => {
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
      removeItem() { throw new Error('denied') }
    })
    const platform = createBrowserMobilePlatform()
    expect(await platform.credentials.read('device')).toBeNull()
    expect(await platform.credentials.write('device', 'secret')).toBe(false)
    expect(await platform.credentials.read('device')).toBe('secret')
    expect(platform.preferences.read('device')).toBeNull()
    expect(platform.preferences.write('draft', 'unsent')).toBe(false)
    expect(platform.preferences.read('draft')).toBe('unsent')
    await platform.credentials.write('device', null)
    expect(await platform.credentials.read('device')).toBeNull()
  })

  it('does not resurrect a removed credential from stale persistent storage', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'old secret',
      setItem: vi.fn(),
      removeItem() { throw new Error('denied') }
    })
    const platform = createBrowserMobilePlatform()
    expect(await platform.credentials.read('device')).toBe('old secret')
    expect(await platform.credentials.write('device', null)).toBe(false)
    expect(await platform.credentials.read('device')).toBeNull()
  })

  it('consumes a launch invitation without navigating or retaining it in history', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('location', { hash: '#pair=private-ticket', pathname: '/mobile/', search: '?theme=dark' })
    vi.stubGlobal('history', { replaceState })
    const platform = createBrowserMobilePlatform()
    expect(platform.takeInvitation()).toBe('#pair=private-ticket')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/mobile/?theme=dark')
  })

  it('forwards foreground changes and releases its listener', () => {
    const page = Object.assign(new EventTarget(), { hidden: false })
    vi.stubGlobal('document', page)
    const platform = createBrowserMobilePlatform()
    const listener = vi.fn()
    const dispose = platform.subscribeActivity(listener)
    expect(platform.isActive()).toBe(true)
    page.hidden = true
    page.dispatchEvent(new Event('visibilitychange'))
    expect(platform.isActive()).toBe(false)
    expect(listener).toHaveBeenLastCalledWith(false)
    dispose()
    page.hidden = false
    page.dispatchEvent(new Event('visibilitychange'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
