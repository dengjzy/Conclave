import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const manager = process.env.npm_execpath
if (!manager) throw new Error('Run with pnpm verify:plugin-sdk')
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(path.join(os.tmpdir(), 'conclave-sdk-consumer-'))
const command = (args, cwd) => {
  const script = /\.[cm]?js$/.test(manager)
  return execFileSync(script ? process.execPath : manager, script ? [manager, ...args] : args, { cwd, stdio: 'inherit' })
}
try {
  const sdk = path.join(root, 'packages/plugin-sdk')
  const { version } = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'))
  const archive = path.join(directory, `conclave-plugin-sdk-${version}.tgz`)
  command(['pack', '--out', archive], sdk)
  const consumer = path.join(directory, 'consumer')
  await cp(path.join(root, 'templates/source-plugin'), consumer, { recursive: true })
  const metadata = path.join(consumer, 'package.json')
  const pkg = JSON.parse(await readFile(metadata, 'utf8'))
  pkg.dependencies['@conclave/plugin-sdk'] = `file:${archive}`
  await writeFile(metadata, JSON.stringify(pkg, null, 2))
  const configFile = path.join(consumer, 'tsconfig.json')
  const config = JSON.parse(await readFile(configFile, 'utf8'))
  config.compilerOptions.skipLibCheck = false
  config.include = ['src/main.ts']
  await writeFile(configFile, JSON.stringify(config, null, 2))
  command(['install', '--ignore-scripts'], consumer)
  command(['run', 'typecheck'], consumer)
  command(['run', 'test'], consumer)
  command(['run', 'build'], consumer)
  const child = spawn(process.execPath, [path.join(consumer, 'dist/plugin/main.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const timeout = setTimeout(() => child.kill(), 10_000)
  const send = (method, params) => child.stdin.write(`${JSON.stringify({ type: 'call', id: method, method, params })}\n`)
  const next = async () => {
    const line = await lines.next()
    if (line.done) throw new Error('Plugin exited before answering')
    return JSON.parse(line.value)
  }
  try {
    send('handshake', { protocolVersion: 1 })
    assert.equal((await next()).result.protocolVersion, 1)
    send('fetch', { source: 'example', key: 'EX-1', settings: {}, credential: { kind: 'none', payload: {} } })
    const message = await next()
    assert.equal(message.type, 'result')
    assert.equal(message.result.key, 'EX-1')
    assert.match(message.result.markdown, /Example issue/)
    process.stdout.write('Packed SDK: independent NodeNext typecheck, template tests, build and protocol smoke passed.\n')
  } finally { clearTimeout(timeout); child.stdin.end(); child.kill() }
} finally { await rm(directory, { recursive: true, force: true }) }
