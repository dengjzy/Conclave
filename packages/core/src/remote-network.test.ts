import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { startRemoteProcess } from './remote-process'
import type { createRemoteStaticServer } from './remote-static'
import { startRemoteNetwork } from './remote-runtime'

type ProcessOptions = Parameters<typeof startRemoteProcess>[0]
type StaticOptions = Parameters<typeof createRemoteStaticServer>[0]
const mocked = vi.hoisted(() => ({
  prepareWeb: vi.fn<(options: { directory: string; signal: AbortSignal }) => Promise<void>>(),
  verifyWeb: vi.fn(async () => {}), verifyTailcat: vi.fn(async () => {}),
  process: vi.fn<(options: ProcessOptions) => Promise<{ close(): Promise<void> }>>(),
  static: vi.fn<(options: StaticOptions) => ReturnType<typeof createRemoteStaticServer>>()
}))
vi.mock('./remote-assets', () => ({ prepareRemoteWebRuntime: mocked.prepareWeb, verifyRemoteWebAssets: mocked.verifyWeb, verifyTailcatAsset: mocked.verifyTailcat }))
vi.mock('./remote-process', () => ({ startRemoteProcess: mocked.process }))
vi.mock('./remote-static', () => ({ createRemoteStaticServer: mocked.static }))
const processes: { options: ProcessOptions; close: ReturnType<typeof vi.fn<() => Promise<void>>> }[] = []
const networks: Awaited<ReturnType<typeof startRemoteNetwork>>[] = []
const directories: string[] = []
const html = Buffer.from('<html>agents-go</html>')
const localClose = vi.fn(async () => {})
beforeEach(() => {
  processes.length = 0
  mocked.prepareWeb.mockReset().mockResolvedValue()
  mocked.verifyTailcat.mockClear()
  mocked.verifyWeb.mockClear()
  localClose.mockClear()
  mocked.static.mockReset().mockResolvedValue({ origin: 'http://127.0.0.1:9911', html, instance: 'snapshot', setPublicOrigin: vi.fn(), close: localClose })
  mocked.process.mockReset().mockImplementation(async (options) => {
    const process = { options, close: vi.fn(async () => {}) }
    processes.push(process)
    if (options.executable.endsWith('/tailcat')) {
      const file = options.env.TAILCAT_ADDR_FILE
      if (!file) throw new Error('missing address file')
      await writeFile(file, `tc${'A'.repeat(50)}`)
    } else options.onOutput?.('https://verified.trycloudflare.com\nRegistered tunnel connection\n')
    return process
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { headers: { 'x-conclave-static-instance': 'snapshot' } })))
})
afterEach(async () => {
  await Promise.all(networks.splice(0).map((network) => network.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  vi.unstubAllGlobals()
})
async function options() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-network-'))
  directories.push(directory)
  const identityDirectory = path.join(directory, 'identity')
  await mkdir(identityDirectory)
  await writeFile(path.join(identityDirectory, 'tailcat.private.json'), '{}', { mode: 0o600 })
  return { assetsDirectory: directory, stateDirectory: path.join(directory, 'session'), identityDirectory, gatewayPort: 43210, signal: new AbortController().signal, onExit: vi.fn(), onWebChanged: vi.fn() }
}
async function start(settings: Parameters<typeof startRemoteNetwork>[0]) {
  const network = await startRemoteNetwork(settings)
  networks.push(network)
  return network
}

it('starts APK access without preparing or starting any web publication', async () => {
  const settings = await options()
  const network = await start({ ...settings, publishWeb: false })
  expect(network.address).toBe(`tc${'A'.repeat(50)}`)
  expect(network.clientUrl).toBeNull()
  expect(network.webState).toBe('disabled')
  expect(mocked.prepareWeb).not.toHaveBeenCalled()
  expect(mocked.static).not.toHaveBeenCalled()
  expect(processes).toHaveLength(1)
  expect(processes[0]?.options.args).toContain(`--key=${path.join(settings.identityDirectory, 'tailcat.private.json')}`)
  expect(processes[0]?.options.args).toContain('43210')
  await network.close()
  await start({ ...settings, publishWeb: false })
  expect(processes[1]?.options.args).toEqual(processes[0]?.options.args)
})

it('returns the Tailcat connection while web assets are still preparing', async () => {
  mocked.prepareWeb.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })))
  const settings = await options()
  const network = await start(settings)
  expect(network.address).toBeTruthy()
  expect(network.webState).toBe('preparing')
  expect(network.clientUrl).toBeNull()
  await network.stopWeb()
  expect(network.webState).toBe('disabled')
  expect(processes[0]?.close).not.toHaveBeenCalled()
  expect(settings.onExit).not.toHaveBeenCalled()
})

it('does not expose the public URL until its snapshot has been verified', async () => {
  let respond: (response: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve })))
  const network = await start(await options())
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  expect(network.clientUrl).toBeNull()
  expect(network.webState).toBe('preparing')
  respond(new Response(html, { headers: { 'x-conclave-static-instance': 'snapshot' } }))
  await vi.waitFor(() => expect(network.webState).toBe('ready'))
  expect(network.clientUrl).toBe('https://verified.trycloudflare.com')
})

it('keeps Tailcat alive after web preparation or Cloudflare exit and supports separate retry', async () => {
  mocked.prepareWeb.mockRejectedValueOnce(new Error('SECRET download failure'))
  const settings = await options()
  const network = await start(settings)
  await vi.waitFor(() => expect(network.webState).toBe('error'))
  expect(network.webProblem).not.toContain('SECRET')
  expect(network.clientUrl).toBeNull()
  expect(processes[0]?.close).not.toHaveBeenCalled()
  network.startWeb()
  await vi.waitFor(() => expect(network.webState).toBe('ready'))
  const cloudflare = processes.find((process) => process.options.executable.endsWith('/cloudflared'))
  if (!cloudflare) throw new Error('cloudflare not started')
  cloudflare.options.onExit()
  expect(network.webState).toBe('error')
  expect(network.clientUrl).toBeNull()
  expect(settings.onExit).not.toHaveBeenCalled()
  expect(processes[0]?.close).not.toHaveBeenCalled()
  network.startWeb()
  await vi.waitFor(() => expect(network.webState).toBe('ready'))
  await network.stopWeb()
  expect(network.clientUrl).toBeNull()
  expect(processes[0]?.close).not.toHaveBeenCalled()
})

it('still stops the whole network if the Tailcat process exits', async () => {
  const settings = await options()
  const network = await start(settings)
  await vi.waitFor(() => expect(network.webState).toBe('ready'))
  processes[0]?.options.onExit()
  expect(settings.onExit).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(processes.every((process) => process.close.mock.calls.length > 0)).toBe(true))
  expect(network.clientUrl).toBeNull()
})

it('refuses to silently replace the lost transport identity of paired devices', async () => {
  const settings = await options()
  await rm(path.join(settings.identityDirectory, 'tailcat.private.json'))
  await expect(startRemoteNetwork({ ...settings, requireExistingKey: true, publishWeb: false })).rejects.toThrow('密钥丢失')
  expect(mocked.process).not.toHaveBeenCalled()
})


it('does not restart web publication after a later stop cancels a queued retry', async () => {
  const network = await start(await options())
  await vi.waitFor(() => expect(network.webState).toBe('ready'))
  const cloudflare = processes[1]
  if (!cloudflare) throw new Error('cloudflare not started')
  let release: () => void = () => {}
  const closing = new Promise<void>((resolve) => { release = resolve })
  cloudflare.close.mockReturnValue(closing)
  cloudflare.options.onExit()
  network.startWeb()
  await network.stopWeb()
  release()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(network.webState).toBe('disabled')
  expect(processes).toHaveLength(2)
  cloudflare.close.mockResolvedValue()
})
