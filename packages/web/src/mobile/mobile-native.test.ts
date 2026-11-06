import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeMobilePlatform } from './mobile-native'
import { loadTailcatRuntime } from './mobile-tailcat'

vi.mock('@capacitor/core', () => ({ registerPlugin: vi.fn() }))
vi.mock('./mobile-tailcat', () => ({ loadTailcatRuntime: vi.fn(async () => {}), dialTailcat: vi.fn() }))

function nativePlugin() {
  let activity: ((event: { active: boolean }) => void) | undefined
  const remove = vi.fn(async () => {})
  const state = { preferences: { theme: 'dark', draft: 'unsent' }, deviceName: '测试 Android', active: true }
  const plugin = {
    initialize: vi.fn(async () => state),
    readCredential: vi.fn(async (_options: { key: string }): Promise<{ value: string | null }> => ({ value: null })),
    writeCredential: vi.fn(async (_options: { key: string; value: string | null }) => {}),
    writePreference: vi.fn(async (_options: { key: string; value: string | null }) => {}),
    scanInvitation: vi.fn<() => Promise<{ value: string | null }>>().mockResolvedValue({ value: null }),
    addListener: vi.fn(async (_event: 'activity', listener: (event: { active: boolean }) => void) => { activity = listener; return { remove } })
  }
  return { plugin, state, remove, activity: (active: boolean) => activity?.({ active }) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function flush() { for (let step = 0; step < 12; step++) await Promise.resolve() }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('native mobile platform', () => {
  it('loads the uncompressed WASM bundled in the APK', async () => {
    const { plugin } = nativePlugin()
    const platform = await createNativeMobilePlatform(plugin)
    await platform.prepareNetwork()
    expect(loadTailcatRuntime).toHaveBeenCalledExactlyOnceWith('/assets/main.wasm')
  })

  it('hydrates preferences before use and persists synchronous cache updates in order', async () => {
    const { plugin } = nativePlugin()
    const platform = await createNativeMobilePlatform(plugin)
    expect(platform.deviceName).toBe('测试 Android')
    expect(platform.preferences.read('theme')).toBe('dark')
    expect(platform.preferences.read('missing')).toBeNull()
    expect(platform.preferences.write('draft', 'next message')).toBe(true)
    expect(platform.preferences.read('draft')).toBe('next message')
    platform.preferences.write('draft', null)
    expect(platform.preferences.read('draft')).toBeNull()
    await flush()
    expect(plugin.writePreference.mock.calls).toEqual([[{ key: 'draft', value: 'next message' }], [{ key: 'draft', value: null }]])
  })

  it('forwards credential values and propagates native storage failures', async () => {
    const { plugin } = nativePlugin()
    const platform = await createNativeMobilePlatform(plugin)
    plugin.readCredential.mockResolvedValue({ value: 'saved-device' })
    expect(await platform.credentials.read('hosts')).toBe('saved-device')
    expect(plugin.readCredential).toHaveBeenCalledWith({ key: 'hosts' })
    expect(await platform.credentials.write('hosts', 'new-device')).toBe(true)
    expect(plugin.writeCredential).toHaveBeenCalledWith({ key: 'hosts', value: 'new-device' })
    await platform.credentials.write('hosts', null)
    expect(plugin.writeCredential).toHaveBeenLastCalledWith({ key: 'hosts', value: null })
    plugin.readCredential.mockRejectedValue(new Error('key unavailable'))
    plugin.writeCredential.mockRejectedValue(new Error('commit failed'))
    await expect(platform.credentials.read('hosts')).rejects.toThrow('key unavailable')
    await expect(platform.credentials.write('hosts', 'new-device')).rejects.toThrow('commit failed')
  })

  it('keeps failed preference writes available for this session and reports non-durable storage', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { plugin } = nativePlugin()
    plugin.writePreference.mockRejectedValue(new Error('disk full'))
    const platform = await createNativeMobilePlatform(plugin)
    platform.preferences.write('private-draft', 'sensitive text')
    await flush()
    expect(platform.preferences.read('private-draft')).toBe('sensitive text')
    expect(platform.preferences.write('theme', 'light')).toBe(false)
    await flush()
    expect(warning).toHaveBeenCalled()
    expect(warning.mock.calls.flat().join(' ')).not.toContain('sensitive text')
    expect(warning.mock.calls.flat().join(' ')).not.toContain('private-draft')
  })

  it('removes the native listener if initialization fails', async () => {
    const { plugin, remove } = nativePlugin()
    plugin.initialize.mockRejectedValue(new Error('initialization failed'))
    await expect(createNativeMobilePlatform(plugin)).rejects.toThrow('initialization failed')
    expect(remove).toHaveBeenCalledOnce()
  })

  it('keeps an activity event that arrives before an older initialization snapshot', async () => {
    const { plugin, state, activity } = nativePlugin()
    const initial = deferred<typeof state>()
    plugin.initialize.mockReturnValue(initial.promise)
    const creating = createNativeMobilePlatform(plugin)
    activity(false)
    initial.resolve({ ...state, active: true })
    const platform = await creating
    expect(platform.isActive()).toBe(false)
    const changed = vi.fn()
    const dispose = platform.subscribeActivity(changed)
    activity(true)
    expect(platform.isActive()).toBe(true)
    expect(changed).toHaveBeenCalledExactlyOnceWith(true)
    dispose(); activity(false)
    expect(platform.isActive()).toBe(false)
    expect(changed).toHaveBeenCalledOnce()
  })

  it('returns raw scan contents or cancellation without fetching or navigating', async () => {
    const navigate = vi.fn()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', { open: navigate, location: { assign: navigate, replace: navigate } })
    const { plugin } = nativePlugin()
    const platform = await createNativeMobilePlatform(plugin)
    plugin.scanInvitation.mockResolvedValueOnce({ value: 'https://unrelated.example/#untrusted' }).mockResolvedValueOnce({ value: null })
    expect(await platform.scanInvitation?.()).toBe('https://unrelated.example/#untrusted')
    expect(await platform.scanInvitation?.()).toBeNull()
    expect(platform.takeInvitation()).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    plugin.scanInvitation.mockRejectedValueOnce(new Error('camera unavailable'))
    await expect(platform.scanInvitation?.()).rejects.toThrow('camera unavailable')
  })
})
