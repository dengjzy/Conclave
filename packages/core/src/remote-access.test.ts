import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RemoteAccessStatus } from '@conclave/protocol'
import { RemoteState } from './remote-state'
import { randomUUID } from 'node:crypto'
import { RemoteAccessService } from './remote-access'

type Network = { clientUrl: string | null; address: string; webState: 'disabled' | 'preparing' | 'ready' | 'error'; webProblem: string | null; startWeb(): void; stopWeb(): Promise<void>; close(): Promise<void> }
type NetworkOptions = { assetsDirectory: string; stateDirectory: string; gatewayPort: number; signal: AbortSignal; publishWeb?: boolean; onExit(): void; onWebChanged(): void }
const runtime = vi.hoisted(() => ({
  supported: vi.fn<() => boolean>(),
  prepare: vi.fn<(options: { directory: string; signal: AbortSignal }) => Promise<void>>(),
  start: vi.fn<(options: NetworkOptions) => Promise<Network>>()
}))
vi.mock('./remote-runtime', () => ({ remoteRuntimeSupported: runtime.supported, prepareTailcatRuntime: runtime.prepare, startRemoteNetwork: runtime.start }))

const cleanup: (() => Promise<void>)[] = []
const networks: Network[] = []
function network() {
  const result: Network = { webState: 'ready', webProblem: null, startWeb: vi.fn(), stopWeb: vi.fn(async () => {}), clientUrl: 'https://test.example.com/', address: 'tc-private-address', close: vi.fn(async () => {}) }
  networks.push(result)
  return result
}
beforeEach(() => {
  runtime.supported.mockReset().mockReturnValue(true)
  runtime.prepare.mockReset().mockResolvedValue()
  runtime.start.mockReset().mockImplementation(async () => network())
  networks.length = 0
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-service-'))
  const statuses: RemoteAccessStatus[] = []
  const service = new RemoteAccessService({ home, call: async () => ({ ok: true }), changed: (status) => statuses.push(status) })
  cleanup.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }) })
  return { service, statuses }
}

it('starts only on request, shares concurrent starts, and keeps invitations out of status', async () => {
  const { service, statuses } = await setup()
  expect(service.status()).toMatchObject({ state: 'disabled', devices: [], clientUrl: null, access: 'control' })
  expect(runtime.prepare).not.toHaveBeenCalled()
  expect(service.start().state).toBe('preparing')
  service.start()
  await vi.waitFor(() => expect(service.status().state).toBe('ready'))
  expect(runtime.prepare).toHaveBeenCalledOnce()
  expect(runtime.start).toHaveBeenCalledOnce()
  const invitation = service.createInvitation()
  const encoded = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('pair')
  if (!encoded) throw new Error('missing pairing fragment')
  expect(JSON.parse(encoded)).toMatchObject({ version: 2, address: 'tc-private-address', expiresAt: invitation.expiresAt })
  expect(JSON.stringify(statuses)).not.toContain('tc-private-address')
  expect(JSON.stringify(service.status())).not.toContain('ticket')
  await service.stop()
  expect(service.status()).toMatchObject({ state: 'disabled', clientUrl: null, devices: [] })
  expect(networks[0]?.close).toHaveBeenCalledOnce()
  expect(() => service.createInvitation()).toThrow('尚未就绪')
})

it('cancels preparation before creating any network service', async () => {
  runtime.prepare.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }))
  const { service, statuses } = await setup()
  service.start()
  await vi.waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce())
  await service.stop()
  expect(service.status().state).toBe('disabled')
  expect(runtime.start).not.toHaveBeenCalled()
  expect(statuses.some((status) => status.state === 'error')).toBe(false)
})

it('cleans a late network startup after stop and ignores stale child exit callbacks', async () => {
  let release: (value: Network) => void = () => {}
  runtime.start.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const { service, statuses } = await setup()
  service.start()
  await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())
  const staleExit = runtime.start.mock.calls[0]?.[0].onExit
  const stopped = service.stop()
  const late = network()
  release(late)
  await stopped
  expect(late.close).toHaveBeenCalledOnce()
  expect(service.status().state).toBe('disabled')
  expect(statuses.some((status) => status.state === 'ready')).toBe(false)
  service.start()
  await vi.waitFor(() => expect(service.status().state).toBe('ready'))
  staleExit?.()
  expect(service.status().state).toBe('ready')
})

it('fails closed on a child exit and can start a fresh session afterwards', async () => {
  const { service } = await setup()
  service.start()
  await vi.waitFor(() => expect(service.status().state).toBe('ready'))
  runtime.start.mock.calls[0]?.[0].onExit()
  await vi.waitFor(() => expect(service.status().state).toBe('error'))
  expect(service.status()).toMatchObject({ clientUrl: null, devices: [] })
  expect(networks[0]?.close).toHaveBeenCalledOnce()
  service.start()
  await vi.waitFor(() => expect(service.status().state).toBe('ready'))
  expect(runtime.start).toHaveBeenCalledTimes(2)
})

it('does not expose backend exception text and refuses unsupported hosts', async () => {
  const { service } = await setup()
  runtime.prepare.mockRejectedValueOnce(new Error('SECRET_IN_DOWNLOAD_ERROR'))
  service.start()
  await vi.waitFor(() => expect(service.status().state).toBe('error'))
  expect(JSON.stringify(service.status())).not.toContain('SECRET')
  expect(service.status().problem).toContain('组件准备失败')
  runtime.start.mockRejectedValueOnce(new Error('SECRET_IN_NETWORK_ERROR'))
  service.start()
  await vi.waitFor(() => expect(service.status().state).toBe('error'))
  expect(service.status().problem).toContain('网络连接未能建立')
  expect(JSON.stringify(service.status())).not.toContain('SECRET')
  runtime.supported.mockReturnValue(false)
  expect(service.status().supported).toBe(false)
  expect(() => service.start()).toThrow('暂不支持')
  await service.close()
  expect(() => service.start()).toThrow('已关闭')
})


it('offers an APK invitation without a public webpage and preserves the strict old web payload', async () => {
  const connected = network()
  connected.clientUrl = null
  connected.webState = 'error'
  connected.webProblem = '网页发布失败'
  runtime.start.mockResolvedValueOnce(connected)
  const { service } = await setup()
  service.start({ web: false })
  await vi.waitFor(() => expect(service.status().state).toBe('ready'))
  expect(runtime.start.mock.calls[0]?.[0].publishWeb).toBe(false)
  expect(service.status()).toMatchObject({ clientUrl: null, webState: 'error', webProblem: '网页发布失败' })
  const invitation = service.createInvitation()
  expect(new URL(invitation.url).hostname).toBe('agents-go.invalid')
  expect(invitation.appUrl).toBe(invitation.url)
  const payload = JSON.parse(new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('pair') ?? '')
  expect(payload).toMatchObject({ nodeId: service.status().nodeId, nodeName: service.status().nodeName })
  connected.clientUrl = 'https://verified.example.com/'
  connected.webState = 'ready'
  runtime.start.mock.calls[0]?.[0].onWebChanged()
  const webInvitation = service.createInvitation()
  expect(new URL(webInvitation.url).origin).toBe('https://verified.example.com')
  const legacyPayload = JSON.parse(new URLSearchParams(new URL(webInvitation.url).hash.slice(1)).get('pair') ?? '')
  expect(Object.keys(legacyPayload).sort()).toEqual(['address', 'expiresAt', 'port', 'ticket', 'version'])
  service.startWeb()
  await service.stopWeb()
  expect(connected.startWeb).toHaveBeenCalledOnce()
  expect(connected.stopWeb).toHaveBeenCalledOnce()
  expect(connected.close).not.toHaveBeenCalled()
})

it('lists and revokes saved devices while disabled without starting the network', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-offline-'))
  const directory = path.join(home, 'remote', 'identity')
  const store = await RemoteState.open(directory)
  const id = randomUUID()
  store.save(43210, [{ id, name: 'Android', createdAt: 1, lastSeenAt: 2, tokenHash: 'a'.repeat(64), writes: [] }])
  const service = new RemoteAccessService({ home, call: async () => ({}), changed() {} })
  cleanup.push(async () => { await service.close(); await rm(home, { recursive: true, force: true }) })
  await vi.waitFor(() => expect(service.status().devices).toMatchObject([{ id, online: false }]))
  expect(service.status().state).toBe('disabled')
  expect(runtime.start).not.toHaveBeenCalled()
  expect((await service.revokeDevice(id)).devices).toEqual([])
  const restored = await RemoteState.open(directory)
  expect(restored.devices).toEqual([])
  expect(restored.identity).toEqual(store.identity)
})
