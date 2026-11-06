import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { prepareRemoteWebRuntime, verifyRemoteWebAssets, verifyTailcatAsset } from './remote-assets'
import { startRemoteProcess } from './remote-process'
import { createRemoteStaticServer } from './remote-static'

export { prepareRemoteRuntime, prepareTailcatRuntime, remoteRuntimeSupported } from './remote-assets'

type RemoteProcess = Awaited<ReturnType<typeof startRemoteProcess>>
type RemoteStatic = Awaited<ReturnType<typeof createRemoteStaticServer>>
type WebRun = { controller: AbortController; child?: RemoteProcess; local?: RemoteStatic; startup?: Promise<void> }
const runFile = promisify(execFile)

async function readAddress(file: string): Promise<string | undefined> {
  try {
    const value = (await readFile(file, 'utf8')).trim()
    if (value.length > 8_192) throw new Error('Tailcat 返回的连接地址不合法。')
    return /^tc[A-Za-z0-9_-]{40,}$/.test(value) ? value : undefined
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function publicPageMatches(url: string, local: RemoteStatic, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
  if (response.status !== 200 || response.headers.get('x-conclave-static-instance') !== local.instance || !response.body) {
    await response.body?.cancel()
    return false
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > local.html.length) return false
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).equals(local.html)
}

export async function startRemoteNetwork(options: {
  assetsDirectory: string
  stateDirectory: string
  identityDirectory: string
  gatewayPort: number
  requireExistingKey?: boolean
  publishWeb?: boolean
  signal: AbortSignal
  onExit: () => void
  onWebChanged: () => void
}): Promise<{
  readonly clientUrl: string | null
  readonly webState: 'disabled' | 'preparing' | 'ready' | 'error'
  readonly webProblem: string | null
  address: string
  startWeb(): void
  stopWeb(): Promise<void>
  close(): Promise<void>
}> {
  if (!Number.isInteger(options.gatewayPort) || options.gatewayPort < 1 || options.gatewayPort > 65_535) throw new Error('远程网关端口不合法。')
  const assetsDirectory = path.resolve(options.assetsDirectory)
  const stateDirectory = path.resolve(options.stateDirectory)
  const identityDirectory = path.resolve(options.identityDirectory)
  const failure = new AbortController()
  const stopped = new AbortController()
  const startup = AbortSignal.any([options.signal, failure.signal, stopped.signal, AbortSignal.timeout(120_000)])
  let child: RemoteProcess | undefined
  let web: WebRun | undefined
  let webState: 'disabled' | 'preparing' | 'ready' | 'error' = 'disabled'
  let webProblem: string | null = null
  let clientUrl: string | null = null
  let webRevision = 0
  let runtimeDirectory: string | undefined
  let ready = false
  let notified = false
  let closing: Promise<void> | undefined
  const stopWeb = async () => {
    webRevision++
    const run = web
    web = undefined
    run?.controller.abort()
    webState = 'disabled'
    webProblem = null
    clientUrl = null
    options.onWebChanged()
    await run?.startup
    await run?.child?.close()
    await run?.local?.close()
  }
  const close = (): Promise<void> => {
    if (closing) return closing
    stopped.abort()
    options.signal.removeEventListener('abort', aborted)
    closing = (async () => {
      await Promise.all([child?.close(), stopWeb()])
      if (runtimeDirectory) await rm(path.join(runtimeDirectory, 'tailcat.addr'), { force: true })
    })()
    return closing
  }
  const aborted = () => { if (ready) void close() }
  const failed = () => {
    failure.abort(new Error('远程连接组件已退出，连接已停止。'))
    if (ready && !stopped.signal.aborted && !notified) {
      notified = true
      options.onExit()
      void close()
    }
  }
  options.signal.addEventListener('abort', aborted, { once: true })
  try {
    await verifyTailcatAsset(assetsDirectory, startup)
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    await chmod(stateDirectory, 0o700)
    await mkdir(identityDirectory, { recursive: true, mode: 0o700 })
    await chmod(identityDirectory, 0o700)
    runtimeDirectory = await mkdtemp(path.join(stateDirectory, 'network-'))
    const directory = runtimeDirectory
    const addressFile = path.join(directory, 'tailcat.addr')
    const keyFile = path.join(identityDirectory, 'tailcat.private.json')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TAILCAT_|TS_DEBUG_|TUNNEL_|CLOUDFLARED_|CLOUDFLARE_)/i.test(key)))
    Object.assign(env, { XDG_CONFIG_HOME: identityDirectory, XDG_CACHE_HOME: identityDirectory })
    try { await stat(keyFile) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      if (options.requireExistingKey) throw new Error('已配对主机的 Tailcat 密钥丢失。')
      const temporary = path.join(directory, 'new.private.json')
      try {
        await runFile(path.join(assetsDirectory, 'cli/tailcat'), ['genkey', `--key=${temporary}`, '--fixed-region', '--derpmap-url=https://tailcat.dev/derpmap.json'], { cwd: directory, env, signal: startup, timeout: 60_000, maxBuffer: 32_768 })
        startup.throwIfAborted()
        await chmod(temporary, 0o600)
        const key = await open(temporary, 'r')
        try { await key.sync() } finally { await key.close() }
        await rename(temporary, keyFile)
        const identity = await open(identityDirectory, 'r')
        try { await identity.sync() } finally { await identity.close() }
      } finally { await rm(temporary, { force: true }) }
    }
    await chmod(keyFile, 0o600)
    startup.throwIfAborted()
    child = await startRemoteProcess({
      executable: path.join(assetsDirectory, 'cli/tailcat'),
      args: ['serve', `--key=${keyFile}`, '--derpmap-url=https://tailcat.dev/derpmap.json', String(options.gatewayPort)],
      directory, env: { ...env, TAILCAT_ADDR_FILE: addressFile },
      logFile: path.join(directory, 'tailcat.log'), onExit: failed,
    })
    startup.throwIfAborted()
    let address: string | undefined
    while (!(address = await readAddress(addressFile))) await delay(100, undefined, { signal: startup })
    startup.throwIfAborted()

    const startWeb = () => {
      if (stopped.signal.aborted || options.signal.aborted || web) return
      webRevision++
      const run: WebRun = { controller: new AbortController() }
      web = run
      webState = 'preparing'
      webProblem = null
      options.onWebChanged()
      const signal = AbortSignal.any([options.signal, stopped.signal, run.controller.signal, AbortSignal.timeout(180_000)])
      const webFailed = () => {
        if (web !== run || stopped.signal.aborted) return
        run.controller.abort()
        clientUrl = null
        webState = 'error'
        webProblem = '手机网页发布失败；APK 连接仍然可用，可以单独重试网页发布。'
        options.onWebChanged()
        void Promise.all([run.child?.close(), run.local?.close()])
      }
      run.startup = (async () => {
        try {
          await prepareRemoteWebRuntime({ directory: assetsDirectory, signal })
          signal.throwIfAborted()
          const webDirectory = await mkdtemp(path.join(directory, 'web-'))
          const config = path.join(webDirectory, 'cloudflared.yml')
          await writeFile(config, '{}\n', { flag: 'wx', mode: 0o600 })
          run.local = await createRemoteStaticServer({ assetsDirectory, onError: webFailed })
          signal.throwIfAborted()
          await verifyRemoteWebAssets(assetsDirectory, signal)
          let publicUrl: string | undefined
          let registered = false
          let recent = ''
          run.child = await startRemoteProcess({
            executable: path.join(assetsDirectory, 'cli/cloudflared'),
            args: ['tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2', '--url', run.local.origin],
            directory: webDirectory, env, logFile: path.join(webDirectory, 'cloudflared.log'), onExit: webFailed,
            onOutput(text) {
              recent = (recent + text).slice(-32_768)
              const match = recent.match(/https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com(?=[\s"/]|$)/)
              if (!publicUrl && match?.[0]) { publicUrl = match[0]; run.local?.setPublicOrigin(publicUrl) }
              if (/\bRegistered tunnel connection\b/.test(recent)) registered = true
            },
          })
          while (!publicUrl || !registered) await delay(100, undefined, { signal })
          while (true) {
            signal.throwIfAborted()
            try { if (await publicPageMatches(publicUrl, run.local, signal)) break } catch { signal.throwIfAborted() }
            await delay(500, undefined, { signal })
          }
          signal.throwIfAborted()
          if (web !== run) return
          clientUrl = publicUrl
          webState = 'ready'
          options.onWebChanged()
        } catch {
          webFailed()
          await run.child?.close()
          await run.local?.close()
          if (web === run) web = undefined
        }
      })()
    }
    ready = true
    if (options.publishWeb !== false) startWeb()
    return {
      get clientUrl() { return clientUrl }, get webState() { return webState }, get webProblem() { return webProblem },
      address, startWeb() {
        if (webState === 'error' && web) {
          const stoppedWeb = stopWeb()
          const revision = webRevision
          void stoppedWeb.then(() => { if (revision === webRevision) startWeb() })
        } else startWeb()
      }, stopWeb, close,
    }
  } catch (error) {
    await close()
    if (failure.signal.aborted) throw failure.signal.reason
    throw error
  }
}
