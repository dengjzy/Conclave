import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractPlugin, packagePath, readManifest } from '../packages/core/src/plugin-package'
import { PluginProcess } from '../packages/core/src/plugin-process'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const archives = process.argv.slice(2)
if (!archives.length) throw new Error('Usage: pnpm exec tsx scripts/verify-source-plugin.ts plugin.zip [...]')
for (const archive of archives) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-plugin-zip-'))
  try {
    await extractPlugin(await readFile(archive), directory)
    const manifest = await readManifest(directory, version)
    const runtime = new PluginProcess(manifest, packagePath(directory, manifest.entry.main), {})
    try {
      const providers = await runtime.providers()
      assert.deepEqual(providers.map((provider) => provider.id), manifest.contributes.sources.map((source) => source.id))
      for (const provider of providers) assert.equal(provider.envCredential?.({}), null)
      process.stdout.write(`${manifest.id}@${manifest.version}: ZIP validation and v1 host loading passed.\n`)
    } finally { runtime.stop() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
