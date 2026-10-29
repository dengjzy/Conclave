import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'

// Drop artifacts left by older builds; task sources are downloaded only when installed.
await rm(new URL('../out/plugins/', import.meta.url), { recursive: true, force: true })

const dsh = fileURLToPath(new URL('../packages/dsh-runtime/', import.meta.url))
await mkdir(`${dsh}/dist`, { recursive: true })
await build({
  entryPoints: ['index', 'filesystem', 'shell', 'powershell'].map((name) => `${dsh}/src/${name}.ts`),
  outdir: `${dsh}/dist`, outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['@deepseek-ai/*', '@agentclientprotocol/*']
})
const manager = process.env.npm_execpath ?? 'pnpm'
const args = ['--dir', dsh, 'pack', '--out', `${dsh}/dist/runtime.tgz`]
const script = /\.[cm]?js$/.test(manager)
execFileSync(script ? process.execPath : manager, script ? [manager, ...args] : args, { stdio: 'pipe' })
