import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Keep in sync with core/src/remote-assets.ts; the upstream Pages deployment is mutable.
const assets = [
  { file: 'main.wasm.gz', sha256: '91e59ba10ef0b4d6ffdab3bb992ffdfb9ed897539d375173a4f6853525e864e6', bytes: 6532187 },
  { file: 'wasm_exec.js', sha256: '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14', bytes: 16992 }
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

export async function readTailcatBrowserAssets(cache) {
  await mkdir(cache, { recursive: true })
  const verified = []
  for (const asset of assets) {
    let bytes
    try { bytes = await readFile(path.join(cache, asset.file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!bytes || bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) {
      const response = await fetch(`https://tailscale.github.io/tailcat/${asset.file}`, { signal: AbortSignal.timeout(120000) })
      if (!response.ok) throw new Error(`Tailcat ${asset.file}: HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error(`Tailcat ${asset.file} differs from the pinned version; refusing to package it`)
      await writeFile(path.join(cache, asset.file), bytes)
    }
    verified.push({ ...asset, bytes })
  }
  return verified
}
