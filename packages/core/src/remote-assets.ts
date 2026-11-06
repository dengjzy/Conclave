import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, open } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

export type PinnedRemoteAsset = { file: string; url: string; sha256: string; bytes: number }
const tailcatArchive: PinnedRemoteAsset = {
  file: 'tailcat_0.7.0_linux_amd64.tar.gz',
  url: 'https://github.com/tailscale/tailcat/releases/download/v0.7.0/tailcat_0.7.0_linux_amd64.tar.gz',
  sha256: '23c0b1887a5ec422f0d18a9c52b4f5357815febdaae738a1eb54036d10bd9ee6', bytes: 7_279_316,
}
const tailcatHash = '75da81231e01f2a52005f26f4eca6df4bce71cb694a42fa467a30e93c3d7a5b9'
// Pages is mutable. Pin the browser build from e00cdde6ff787f801361ff85ed085775c775d4c5.
const downloads: PinnedRemoteAsset[] = [
  { file: 'main.wasm.gz', url: 'https://tailscale.github.io/tailcat/main.wasm.gz', sha256: '91e59ba10ef0b4d6ffdab3bb992ffdfb9ed897539d375173a4f6853525e864e6', bytes: 6_532_187 },
  { file: 'wasm_exec.js', url: 'https://tailscale.github.io/tailcat/wasm_exec.js', sha256: '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14', bytes: 16_992 },
  { file: 'cli/cloudflared', url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-linux-amd64', sha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872', bytes: 40_274_445 },
]
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function remoteRuntimeSupported(): boolean { return process.platform === 'linux' && process.arch === 'x64' }

export function requireRemotePlatform(): void {
  if (!remoteRuntimeSupported()) throw new Error('手机远程连接实验暂时只支持 Linux x64。')
}

async function matches(file: string, sha256: string): Promise<boolean> {
  try { return hash(await readFile(file)) === sha256 } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function fetchHttps(url: string, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; redirects < 6; redirects++) {
    if (new URL(url).protocol !== 'https:') throw new Error('远程组件下载仅允许 HTTPS。')
    const response = await fetch(url, { signal, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('远程组件下载重定向缺少地址。')
      url = new URL(location, url).href
      continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`远程组件下载失败：HTTP ${response.status}。`) }
    return response
  }
  throw new Error('远程组件下载重定向过多。')
}

export async function preparePinnedAsset(asset: PinnedRemoteAsset, directory: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const target = path.join(directory, asset.file)
  if (await matches(target, asset.sha256)) return target
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.partial`
  try {
    const response = await fetchHttps(asset.url, AbortSignal.any([signal, AbortSignal.timeout(600_000)]))
    if (!response.body) throw new Error('远程组件下载内容为空。')
    const file = await open(temporary, 'wx', 0o600)
    const checksum = createHash('sha256')
    let size = 0
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted()
        size += chunk.byteLength
        if (size > asset.bytes) throw new Error(`远程组件 ${asset.file} 超过预期大小。`)
        checksum.update(chunk)
        await file.writeFile(chunk)
      }
    } finally { await file.close() }
    if (size !== asset.bytes || checksum.digest('hex') !== asset.sha256) {
      throw new Error(`远程组件 ${asset.file} 校验失败，未安装。官方浏览器构建可能已更新，请更新固定版本后重试。`)
    }
    signal.throwIfAborted()
    await chmod(temporary, asset.file.startsWith('cli/') ? 0o755 : 0o644)
    await rename(temporary, target)
    return target
  } finally { await rm(temporary, { force: true }) }
}

function archiveExecutable(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 })
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/s, '')
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8)
    if (!name) break
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) break
    if (name === 'tailcat' && (tar[offset + 156] === 48 || tar[offset + 156] === 0)) return tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Tailcat 发布包缺少可执行文件。')
}

export async function prepareTailcatRuntime({ directory, signal }: { directory: string; signal: AbortSignal }): Promise<void> {
  requireRemotePlatform()
  signal.throwIfAborted()
  directory = path.resolve(directory)
  await mkdir(path.join(directory, 'cli'), { recursive: true })
  const binary = path.join(directory, 'cli/tailcat')
  if (!(await matches(binary, tailcatHash))) {
    const archive = await preparePinnedAsset(tailcatArchive, directory, signal)
    const executable = archiveExecutable(await readFile(archive))
    if (hash(executable) !== tailcatHash) throw new Error('Tailcat 可执行文件校验失败。')
    signal.throwIfAborted()
    const temporary = `${binary}.${randomUUID()}.partial`
    try {
      const file = await open(temporary, 'wx', 0o755)
      try { await file.writeFile(executable) } finally { await file.close() }
      signal.throwIfAborted()
      await rename(temporary, binary)
    } finally { await rm(temporary, { force: true }) }
  }
  await chmod(binary, 0o755)
  await verifyTailcatAsset(directory, signal)
}

async function verifyAssets(directory: string, signal: AbortSignal, assets: { file: string; sha256: string }[]): Promise<void> {
  requireRemotePlatform()
  for (const asset of assets) {
    signal.throwIfAborted()
    if (!(await matches(path.join(directory, asset.file), asset.sha256))) throw new Error(`远程组件 ${asset.file} 校验失败，请重新准备组件。`)
  }
}

export async function prepareRemoteWebRuntime({ directory, signal }: { directory: string; signal: AbortSignal }): Promise<void> {
  requireRemotePlatform()
  for (const asset of downloads) await preparePinnedAsset(asset, directory, signal)
  await chmod(path.join(directory, 'cli/cloudflared'), 0o755)
  await verifyRemoteWebAssets(directory, signal)
}

export async function prepareRemoteRuntime(options: { directory: string; signal: AbortSignal }): Promise<void> {
  await prepareTailcatRuntime(options)
  await prepareRemoteWebRuntime(options)
}

export function verifyTailcatAsset(directory: string, signal: AbortSignal): Promise<void> {
  return verifyAssets(directory, signal, [{ file: 'cli/tailcat', sha256: tailcatHash }])
}

export function verifyRemoteWebAssets(directory: string, signal: AbortSignal): Promise<void> {
  return verifyAssets(directory, signal, downloads)
}

export async function verifyRemoteAssets(directory: string, signal: AbortSignal): Promise<void> {
  await verifyTailcatAsset(directory, signal)
  await verifyRemoteWebAssets(directory, signal)
}
