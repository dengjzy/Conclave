#!/usr/bin/env node
// A headless check that this checkout boots and answers: an isolated core, its own home and port,
// no daemon and no agent. It is the gate that catches a change which compiles and passes unit
// tests but cannot start — the failure mode a self-evolution loop produces most often.
//
//   pnpm self:smoke            (node --import tsx scripts/self-smoke.mjs)
//   --keep                     leave the temp home and the core log for debugging
//   --repo <path>              the checkout to start (default: this repository)
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '../packages/protocol/src/index.ts'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REQUIRED_FEATURES = ['flows', 'ideas', 'task-contracts']
const START_TIMEOUT_MS = 90_000

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const repoIndex = args.indexOf('--repo')
const repo = repoIndex >= 0 ? path.resolve(args[repoIndex + 1] ?? ROOT) : ROOT

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let next = 0
    const call = (method, params = {}) => new Promise((done, fail) => {
      const id = ++next
      pending.set(id, { done, fail })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.fail(new Error(`${message.error.message}${message.error.data?.reason ? ` (${message.error.data.reason})` : ''}`))
      else waiter.done(message.result)
    })
    socket.addEventListener('error', () => reject(new Error(`cannot reach ${url}`)))
    socket.addEventListener('open', () => resolve({ call, close: () => socket.close() }))
  })
}

async function serving(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/conclave`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

async function main() {
  const port = await freePort()
  const home = await mkdtemp(path.join(os.tmpdir(), 'conclave-self-smoke-'))
  const output = []
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/core/src/main.ts', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: repo,
    env: { ...process.env, CONCLAVE_HOME: home, CONCLAVE_PORT: String(port), CONCLAVE_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (data) => output.push(String(data)))
  child.stderr.on('data', (data) => output.push(String(data)))
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  let socket = null
  try {
    const started = await Promise.race([
      (async () => {
        while (!(await serving(port))) {
          if (child.exitCode !== null) throw new Error(`core exited with ${child.exitCode}`)
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        return true
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), START_TIMEOUT_MS))
    ])
    if (!started) throw new Error(`core did not serve within ${START_TIMEOUT_MS / 1000}s`)

    const endpoint = JSON.parse(await readFile(path.join(home, 'core.json'), 'utf8'))
    socket = await connect(`ws://127.0.0.1:${endpoint.port}/?token=${endpoint.token}`)
    const { call } = socket
    const hello = await call('system.hello', { protocolVersion: PROTOCOL_VERSION })
    if (hello.protocolVersion !== PROTOCOL_VERSION) throw new Error(`protocol ${hello.protocolVersion}, expected ${PROTOCOL_VERSION}`)
    const missing = REQUIRED_FEATURES.filter((feature) => !hello.features.includes(feature))
    if (missing.length > 0) throw new Error(`features missing: ${missing.join(', ')}`)

    const idea = await call('ideas.create', { title: 'smoke', notes: '', status: 'idea', tags: [], projectPath: null })
    const listed = await call('ideas.list', {})
    if (!listed.some((each) => each.id === idea.id)) throw new Error('ideas.list did not return the created idea')
    await call('ideas.update', { id: idea.id, status: 'todo' })
    await call('ideas.remove', { id: idea.id })
    if ((await call('ideas.list', {})).length !== 0) throw new Error('ideas.remove left the idea behind')

    const task = await call('tasks.create', { title: 'smoke', details: '', repos: [repo], agent: 'claude', dependsOn: [] })
    const contract = await call('tasks.setContract', {
      id: task.id,
      contract: {
        goal: 'smoke',
        verification: { checks: [{ repo, command: 'true', timeoutMs: 5000, required: true }], baseline: [], criteria: [], human: [], unknowns: [] },
        constraints: { maxAttempts: 1, maxWallClockMs: 60_000 },
        risk: 'low',
        autonomy: 'confirm'
      }
    })
    if (contract.verification.checks.length !== 1) throw new Error('the contract lost its check')
    if (!contract.verification.trustedHash) throw new Error('the contract has no trust hash')
    if ((await call('tasks.contract', { id: task.id })).verification.checks.length !== 1) throw new Error('the contract did not read back')
    await call('tasks.delete', { id: task.id })

    console.log(`self-smoke: ok · protocol ${hello.protocolVersion} · ${hello.features.length} features · ideas · contract`)
    return 0
  } catch (error) {
    console.error(`self-smoke: failed · ${error instanceof Error ? error.message : String(error)}`)
    console.error(output.join('').split('\n').slice(-25).join('\n'))
    return 1
  } finally {
    socket?.close()
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
    if (child.exitCode === null) child.kill('SIGKILL')
    if (keep) console.error(`self-smoke: kept ${home} and its core log (pid ${child.pid})`)
    else await rm(home, { recursive: true, force: true })
  }
}

process.exit(await main())
