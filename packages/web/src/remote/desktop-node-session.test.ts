import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRpcClient, type RpcConnection } from '@conclave/protocol'
import { desktopNodeUrl, pairDesktopNode, pauseDesktopNode, prepareDesktopNodeSession, removeDesktopNode, resumeDesktopNode, switchDesktopNode, useDesktopNodeSession } from './desktop-node-session'

const mocks = vi.hoisted(() => {
  const selection: { activeHostId: string | null } = { activeHostId: null }
  return ({
  connect: vi.fn<() => Promise<void>>(), disconnect: vi.fn(), importInvitation: vi.fn<(link: string) => void>(),
  flush: vi.fn<() => Promise<boolean>>(), endpoint: vi.fn(), localRpc: vi.fn(), desktopRpc: vi.fn(), assign: vi.fn(),
  hosts: [{ id: 'saved-one', name: '电脑一', deviceName: '浏览器', lastConnectedAt: null }],
  ...selection, isPairing: false, storageNotice: ''
}) })
vi.mock('../core-endpoint', () => ({ resolveCoreEndpoint: mocks.endpoint }))
vi.mock('@conclave/protocol', async (original) => ({ ...await original<typeof import('@conclave/protocol')>(), connectRpc: mocks.localRpc }))
vi.mock('./node-rpc', () => ({ connectDesktopRpc: mocks.desktopRpc }))
vi.mock('./node-connection', () => ({ NodeConnection: class {
  ready = Promise.resolve()
  platform = { deviceName: '桌面测试端' }
  get hosts() { return mocks.hosts }
  get activeHostId() { return mocks.activeHostId }
  get isPairing() { return mocks.isPairing }
  get storageNotice() { return mocks.storageNotice }
  connect = mocks.connect
  disconnect = mocks.disconnect
  importInvitation = mocks.importInvitation
  selectHost(id: string) { mocks.activeHostId = id; mocks.isPairing = false }
  forget() { mocks.hosts = mocks.hosts.filter((host) => host.id !== mocks.activeHostId); mocks.activeHostId = null }
  flushCredentials = mocks.flush
} }))
function page(search = '', origin = 'http://localhost:5173') {
  vi.stubGlobal('window', { location: { search, href: `${origin}/conclave${search}`, assign: mocks.assign } })
}
function connection(): RpcConnection {
  return { ...createRpcClient(() => {}), close: vi.fn(), closed: new Promise(() => {}), features: [] }
}
beforeEach(() => {
  vi.clearAllMocks()
  useDesktopNodeSession.setState(useDesktopNodeSession.getInitialState(), true)
  mocks.hosts = [{ id: 'saved-one', name: '电脑一', deviceName: '浏览器', lastConnectedAt: null }]
  mocks.activeHostId = null; mocks.isPairing = false; mocks.storageNotice = ''
  mocks.connect.mockResolvedValue(); mocks.flush.mockResolvedValue(true)
  mocks.endpoint.mockResolvedValue({ port: 1234, token: 'local-secret' })
  mocks.localRpc.mockResolvedValue(connection()); mocks.desktopRpc.mockResolvedValue(connection())
  page()
})
afterEach(() => vi.unstubAllGlobals())

describe('desktop node routing and lifetime', () => {
  it('uses the local endpoint only for the explicit local environment', async () => {
    const connector = await prepareDesktopNodeSession({ localAvailable: true })
    await connector()
    expect(mocks.endpoint).toHaveBeenCalledOnce()
    expect(mocks.localRpc).toHaveBeenCalledOnce()
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it.each(['', '?node=local', '?node=missing'])('never falls back to a local endpoint on the public entry %s', async (query) => {
    page(query, 'https://client.example.test')
    const connector = await prepareDesktopNodeSession({ localAvailable: false })
    expect(await connector()).toBeNull()
    expect(mocks.endpoint).not.toHaveBeenCalled()
    expect(mocks.localRpc).not.toHaveBeenCalled()
    expect(useDesktopNodeSession.getState().dialogOpen).toBe(true)
  })
  it('resumes only the exact saved node and exposes errors without local fallback', async () => {
    page('?node=saved-one')
    const connector = await prepareDesktopNodeSession({ localAvailable: true })
    mocks.connect.mockRejectedValueOnce(new Error('远端离线'))
    await expect(connector()).rejects.toThrow('远端离线')
    expect(mocks.activeHostId).toBe('saved-one')
    expect(useDesktopNodeSession.getState().error).toBe('远端离线')
    expect(mocks.endpoint).not.toHaveBeenCalled()
    pauseDesktopNode()
    expect(await connector()).toBeNull()
    resumeDesktopNode()
    expect(await connector()).toBe(await mocks.desktopRpc.mock.results[0]?.value)
    expect(mocks.connect).toHaveBeenCalledTimes(2)
  })
  it('does not publish a remote adapter that finishes after disconnect', async () => {
    page('?node=saved-one')
    const connector = await prepareDesktopNodeSession({ localAvailable: true })
    let finish: (rpc: RpcConnection) => void = () => {}
    mocks.desktopRpc.mockReturnValueOnce(new Promise<RpcConnection>((resolve) => { finish = resolve }))
    const opening = connector()
    await Promise.resolve()
    pauseDesktopNode()
    const rpc = connection(); finish(rpc)
    expect(await opening).toBeNull()
    expect(rpc.close).toHaveBeenCalledOnce()
  })
  it('switches documents with a clean node URL instead of mutating the live workspace', async () => {
    await prepareDesktopNodeSession({ localAvailable: true })
    switchDesktopNode('saved-one')
    expect(mocks.assign).toHaveBeenCalledWith('http://localhost:5173/conclave?node=saved-one')
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(desktopNodeUrl(null, 'https://client.example.test/conclave?node=one&token=secret&port=42&view=chat#pair=secret')).toBe('https://client.example.test/conclave?view=chat')
  })
  it('keeps pairing links as data and navigates only after the saved host is ready', async () => {
    page('?node=connect', 'https://client.example.test')
    await prepareDesktopNodeSession({ localAvailable: false })
    mocks.connect.mockImplementationOnce(async () => { mocks.activeHostId = 'saved-one' })
    await pairDesktopNode('https://computer.example.test/mobile.html#pair=opaque', '我的电脑')
    expect(mocks.importInvitation).toHaveBeenCalledWith('https://computer.example.test/mobile.html#pair=opaque')
    expect(mocks.assign).toHaveBeenCalledWith('https://client.example.test/conclave?node=saved-one')
  })
  it('does not reload after credential storage fails', async () => {
    await prepareDesktopNodeSession({ localAvailable: true })
    mocks.connect.mockImplementationOnce(async () => { mocks.activeHostId = 'saved-one'; mocks.storageNotice = '无法保存' })
    await expect(pairDesktopNode('invitation', '电脑')).rejects.toThrow('无法保存')
    expect(mocks.assign).not.toHaveBeenCalled()
    expect(useDesktopNodeSession.getState()).toMatchObject({ connecting: false, paused: true })
  })
  it('waits for credential removal before reloading and reports failed persistence', async () => {
    page('?node=saved-one')
    await prepareDesktopNodeSession({ localAvailable: true })
    let finish: (saved: boolean) => void = () => {}
    mocks.flush.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve }))
    const removing = removeDesktopNode('saved-one')
    expect(mocks.assign).not.toHaveBeenCalled()
    finish(false)
    await expect(removing).rejects.toThrow('设备存储未能保存')
    expect(mocks.assign).not.toHaveBeenCalled()
  })
})
