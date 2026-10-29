import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'
import { PluginManifest } from '@conclave/plugin-sdk'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = PluginManifest.parse(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (pkg.version !== manifest.version) throw new Error('package.json and manifest.json versions must match')
if (manifest.entry.main !== 'main.mjs') throw new Error('Expected main.mjs entry')
const dist = path.join(root, 'dist')
const artifact = path.join(dist, 'plugin')
await mkdir(artifact, { recursive: true })
await build({ entryPoints: [path.join(root, 'src/main.ts')], outfile: path.join(artifact, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' })
const metadata = JSON.stringify(manifest, null, 2) + '\n'
await writeFile(path.join(artifact, 'manifest.json'), metadata)
const archive = zipSync({ 'manifest.json': strToU8(metadata), 'main.mjs': new Uint8Array(await readFile(path.join(artifact, 'main.mjs'))) })
const name = `${pkg.name}-${pkg.version}.zip`
await writeFile(path.join(dist, name), archive)
process.stdout.write(`Built dist/${name}\n`)
