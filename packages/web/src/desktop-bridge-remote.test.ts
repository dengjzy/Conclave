import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canImportBookmarks, canOpenFile, canOpenWith, canPickFolder, canRevealFile, canShowNativeBrowser, canShowRequestPopup, openFile, openWith, pickFolder, pickPlugin, revealFile, showNativeBrowserTab, wantRequestPopup } from './desktop-bridge'
import { isRemoteDesktopNode } from './remote/desktop-node-mode'
const native = {
  pickFolder: vi.fn(async () => '/local'), openFile: vi.fn(async () => null), openWith: vi.fn(async () => null),
  revealFile: vi.fn(async () => null), pickPlugin: vi.fn(async () => '/local/plugin'), browserShow: vi.fn(),
  requestPopup: vi.fn(), bookmarkSources: vi.fn()
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', { location: { search: '?node=remote-computer' }, conclave: native }) })
afterEach(() => vi.unstubAllGlobals())
describe('native boundaries while showing a remote node', () => {
  it('disables local filesystem, browser and popup capabilities', () => {
    expect([canPickFolder(), canOpenFile(), canOpenWith(), canRevealFile(), canShowNativeBrowser(), canShowRequestPopup(), canImportBookmarks()]).toEqual(Array(7).fill(false))
  })
  it('never forwards remote paths or node UI operations to the local preload', async () => {
    expect(await pickFolder('/remote')).toBeNull()
    expect(await revealFile(['/remote'])).toBeNull()
    expect(await pickPlugin('directory')).toBeNull()
    expect(await openFile('/remote')).toContain('节点电脑')
    expect(await openWith('/remote', 'editor')).toContain('节点电脑')
    showNativeBrowserTab('remote-tab'); wantRequestPopup(true)
    for (const action of Object.values(native)) expect(action).not.toHaveBeenCalled()
  })
  it('keeps the existing local native behavior', async () => {
    vi.stubGlobal('window', { location: { search: '' }, conclave: native })
    expect(canPickFolder()).toBe(true)
    expect(await pickFolder('/local')).toBe('/local')
    expect(native.pickFolder).toHaveBeenCalledWith('/local', undefined)
  })
  it('requires no session store or browser-only state to identify a local document', () => {
    vi.stubGlobal('window', {})
    expect(isRemoteDesktopNode()).toBe(false)
    vi.stubGlobal('window', undefined)
    expect(isRemoteDesktopNode()).toBe(false)
  })
})
