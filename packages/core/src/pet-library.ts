import { mkdir, mkdtemp, readFile, rm, lstat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { comparePetVersions, PetCatalog, PetManifest, PetMetadata, petAssetFiles, type PetCatalogEntry, type PetLibraryState, type PetResourceData } from '@conclave/protocol'
import { readJsonIfExists, writePrivateJson } from '@conclave/protocol/node'
import fallback from '../../protocol/src/pet-catalog.json' with { type: 'json' }
import { networkFailure } from './network-failure'
import { renameWhenFree } from './patient-rename'
import { unpackPet, validatePetFiles, webpSize } from './pet-package'
import { Rejection } from './rejection'

const Installed = z.array(PetMetadata).max(100)
// Older apps keep their three-image packages through the original catalog.
const CATALOG_URL = 'https://raw.githubusercontent.com/dengjzy/conclave-pets/main/catalog-v2.json'
type Download = { abort: AbortController; received: number; total: number; done: Promise<PetLibraryState> }

function validateCatalog(value: unknown): PetCatalog {
  const catalog = PetCatalog.parse(value)
  for (const entry of catalog.pets) {
    const data = Buffer.from(entry.preview.slice(entry.preview.indexOf(',') + 1), 'base64')
    const png = entry.preview.startsWith('data:image/png;')
    if (png && (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a')) throw new Error('Invalid pet thumbnail')
    const { width, height } = png ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : webpSize(data)
    if (width < 1 || height < 1 || width > 512 || height > 512) throw new Error('Pet thumbnail is too large')
  }
  return catalog
}

export class PetLibrary {
  private catalog = PetCatalog.parse(fallback)
  private installed: z.infer<typeof Installed> = []
  private downloads = new Map<string, Download>()
  private pending: Promise<unknown> = Promise.resolve()
  private refreshing: Promise<void> | null = null
  private closing = false
  private readonly closed = new AbortController()
  constructor(private readonly root: string, private readonly options: {
    changed?: (state: PetLibraryState) => void
    fetch?: typeof fetch
    // A local catalog and its sibling ZIP files, explicitly configured for development.
    developmentDirectory?: string
  } = {}) {}

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const cached = await readJsonIfExists(path.join(this.root, 'catalog.json')).catch(() => undefined)
    if (cached !== undefined) try { this.catalog = validateCatalog(cached) } catch { /* Ignore a damaged cache. */ }
    const raw = await readJsonIfExists(path.join(this.root, 'installed.json')).catch(() => undefined)
    const records = Installed.safeParse(raw)
    if (records.success) for (const item of records.data) {
      try {
        const manifest = await this.manifest(item.id, item.version)
        if (manifest.id === item.id && manifest.version === item.version) this.installed.push(PetMetadata.parse(manifest))
      } catch { /* A missing package falls back to the built-in pet. */ }
    }
  }

  state(): PetLibraryState {
    return { catalog: this.catalog.pets.filter((p) => p.id !== 'clay'), installed: [...this.installed], downloads: [...this.downloads].map(([id, d]) => ({ id, received: d.received, total: d.total })) }
  }

  async list(refresh = false): Promise<PetLibraryState> {
    if (refresh && !this.closing) {
      this.refreshing ??= this.refreshCatalog().finally(() => { this.refreshing = null })
      await this.refreshing
    }
    return this.state()
  }

  install(id: string): Promise<PetLibraryState> {
    if (this.closing) return Promise.reject(new Rejection('pets-unavailable'))
    if (id === 'clay') return Promise.reject(new Rejection('pet-builtin'))
    const active = this.downloads.get(id)
    if (active) return active.done
    const entry = this.catalog.pets.find((p) => p.id === id)
    if (!entry) return this.installed.some((p) => p.id === id) ? Promise.resolve(this.state()) : Promise.reject(new Rejection('pet-not-found'))
    if (this.installed.some((p) => p.id === id && comparePetVersions(p.version, entry.version) >= 0)) return Promise.resolve(this.state())
    const download: Download = { abort: new AbortController(), received: 0, total: entry.size, done: Promise.resolve(this.state()) }
    this.downloads.set(id, download); this.publish()
    download.done = this.installInner(entry, download).catch((error: unknown) => {
      if (download.abort.signal.aborted) throw new Rejection('pet-cancelled')
      throw new Rejection('pet-download-failed', error instanceof Error ? error.message : 'Pet installation failed')
    }).finally(() => { this.downloads.delete(id); this.publish() }).then(() => this.state())
    return download.done
  }

  cancel(id: string): void { this.downloads.get(id)?.abort.abort() }

  remove(id: string): Promise<PetLibraryState> {
    return this.serialize(async () => {
      if (id === 'clay') throw new Rejection('pet-builtin')
      if (this.downloads.has(id)) throw new Rejection('pet-downloading')
      const next = this.installed.filter((p) => p.id !== id)
      await writePrivateJson(path.join(this.root, 'installed.json'), next)
      this.installed = next; this.publish()
      await rm(path.join(this.root, id), { recursive: true, force: true })
      return this.state()
    })
  }

  async read(id: string): Promise<PetResourceData> {
    const record = this.installed.find((p) => p.id === id)
    if (!record) throw new Rejection('pet-not-installed')
    const manifest = await this.manifest(id, record.version), folder = path.join(this.root, id, record.version)
    const files = new Map<string, Buffer>()
    for (const name of petAssetFiles(manifest)) {
      const file = path.join(folder, name), info = await lstat(file)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Rejection('pet-invalid')
      files.set(name, await readFile(file))
    }
    validatePetFiles(manifest, files)
    return { manifest, assets: {
      'poses.webp': files.get('poses.webp')?.toString('base64') ?? '',
      'walk.webp': files.get('walk.webp')?.toString('base64') ?? '',
      'face.webp': files.get('face.webp')?.toString('base64') ?? '',
      ...(manifest.rig.typing ? { 'typing.webp': files.get('typing.webp')?.toString('base64') ?? '', 'typing-base.webp': files.get('typing-base.webp')?.toString('base64') ?? '' } : {})
    } }
  }

  async close(): Promise<void> {
    this.closing = true; this.closed.abort()
    for (const d of this.downloads.values()) d.abort.abort()
    await Promise.allSettled([...this.downloads.values()].map((d) => d.done))
    await this.pending.catch(() => {})
    await this.refreshing?.catch(() => {})
  }

  private publish(): void { this.options.changed?.(this.state()) }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pending.then(run); this.pending = next.catch(() => {}); return next
  }
  private async manifest(id: string, version: string): Promise<PetManifest> {
    const file = path.join(this.root, id, version, 'manifest.json'), info = await lstat(file)
    if (!info.isFile() || info.size > 64 * 1024) throw new Rejection('pet-invalid')
    return PetManifest.parse(JSON.parse(await readFile(file, 'utf8')))
  }
  private async refreshCatalog(): Promise<void> {
    try {
      const bytes = this.options.developmentDirectory
        ? await readFile(path.join(this.options.developmentDirectory, 'catalog.json'))
        : await this.download(CATALOG_URL, 1024 * 1024, AbortSignal.any([this.closed.signal, AbortSignal.timeout(10_000)]))
      const catalog = validateCatalog(JSON.parse(bytes.toString('utf8')))
      for (const entry of catalog.pets) this.checkUrl(entry)
      await writePrivateJson(path.join(this.root, 'catalog.json'), catalog)
      this.catalog = catalog; this.publish()
    } catch { /* Keep the cached or bundled catalog available offline. */ }
  }
  private checkUrl(entry: PetCatalogEntry): void {
    const url = new URL(entry.url)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/dengjzy/conclave-pets/releases/download/')) throw new Error('Pet package is not from the configured repository')
  }
  private async installInner(entry: PetCatalogEntry, download: Download): Promise<PetLibraryState> {
    this.checkUrl(entry)
    const signal = AbortSignal.any([download.abort.signal, AbortSignal.timeout(60_000)])
    let previous = 0
    const progress = (received: number) => {
      download.received = received
      if (Date.now() - previous >= 100) { previous = Date.now(); this.publish() }
    }
    const data = this.options.developmentDirectory
      ? await readFile(path.join(this.options.developmentDirectory, `${entry.id}-${entry.version}.zip`), { signal })
      : await this.download(entry.url, entry.size, signal, progress)
    signal.throwIfAborted()
    const { manifest, files } = await unpackPet(data, entry)
    return this.serialize(async () => {
      signal.throwIfAborted()
      const staging = await mkdtemp(path.join(this.root, '.install-'))
      try {
        for (const [name, data] of files) await writeFile(path.join(staging, name), data, { mode: 0o600, flag: 'wx' })
        const parent = path.join(this.root, manifest.id), destination = path.join(parent, manifest.version)
        await mkdir(parent, { recursive: true, mode: 0o700 })
        // An interrupted install may have left an unreferenced version directory.
        if (!this.installed.some((p) => p.id === manifest.id && p.version === manifest.version)) await rm(destination, { recursive: true, force: true })
        signal.throwIfAborted()
        await renameWhenFree(staging, destination)
        const next = [...this.installed.filter((p) => p.id !== manifest.id), PetMetadata.parse(manifest)]
        await writePrivateJson(path.join(this.root, 'installed.json'), next)
        this.installed = next; this.publish()
        return this.state()
      } finally { await rm(staging, { recursive: true, force: true }) }
    })
  }
  private async download(url: string, limit: number, signal: AbortSignal, progress?: (received: number) => void): Promise<Buffer> {
    // A user's cancel stays a cancel; anything else the network did is said in words.
    const failed = (error: unknown) => signal.aborted && !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError') ? error : networkFailure(url, error)
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(url, { signal, headers: { 'User-Agent': 'Conclave' } })
    } catch (error) {
      throw failed(error)
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('Pet download is too large') }
    const chunks: Uint8Array[] = []; let size = 0
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted(); size += chunk.length
        if (size > limit) break
        chunks.push(chunk); progress?.(size)
      }
    } catch (error) {
      throw failed(error)
    }
    if (size > limit) throw new Error('Pet download is too large')
    return Buffer.concat(chunks)
  }
}
