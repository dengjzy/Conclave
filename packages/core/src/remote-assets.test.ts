import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preparePinnedAsset } from './remote-assets'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function directory() { const root = await mkdtemp(path.join(os.tmpdir(), 'conclave-remote-assets-')); roots.push(root); return root }
const content = Buffer.from('a pinned asset')
const asset = { file: 'asset.js', url: 'https://official.example/asset.js', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }

describe('pinned remote assets', () => {
  it('accepts matching cached bytes without a network request', async () => {
    const root = await directory()
    await writeFile(path.join(root, asset.file), content)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await preparePinnedAsset(asset, root, new AbortController().signal)).toBe(path.join(root, asset.file))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never replaces a cached file with a corrupt upstream response and removes the partial', async () => {
    const root = await directory()
    await writeFile(path.join(root, asset.file), 'old bytes')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('b pinned asset')))
    await expect(preparePinnedAsset(asset, root, new AbortController().signal)).rejects.toThrow('校验失败')
    expect(await readFile(path.join(root, asset.file), 'utf8')).toBe('old bytes')
    expect(await readdir(root)).toEqual([asset.file])
  })

  it('refuses an HTTPS downgrade before following the redirect', async () => {
    const root = await directory()
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://untrusted.example/asset.js' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(preparePinnedAsset(asset, root, new AbortController().signal)).rejects.toThrow('HTTPS')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await readdir(root)).toEqual([])
  })

  it('bounds downloads before installing oversized bytes', async () => {
    const root = await directory()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a pinned asset plus extra bytes')))
    await expect(preparePinnedAsset(asset, root, new AbortController().signal)).rejects.toThrow('预期大小')
    expect(await readdir(root)).toEqual([])
  })

  it('installs verified bytes and stops immediately if already cancelled', async () => {
    const root = await directory()
    const fetcher = vi.fn(async () => new Response(content))
    vi.stubGlobal('fetch', fetcher)
    await preparePinnedAsset(asset, root, new AbortController().signal)
    expect(await readFile(path.join(root, asset.file))).toEqual(content)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(preparePinnedAsset(asset, root, controller.signal)).rejects.toThrow('cancelled')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
