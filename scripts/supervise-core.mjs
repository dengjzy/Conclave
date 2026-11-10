#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A small dev supervisor: keep the core up while iterating. `tsx watch` restarts on file changes;
// this restarts it if the process dies and probes /conclave when it stays alive but stops serving.
const port = process.env.CONCLAVE_PORT ?? process.env.PORT ?? '43551'
const home = process.env.CONCLAVE_HOME ?? path.join(os.homedir(), '.conclave')
// A copy on disk that an agent inside Conclave can read; the terminal scrollback is not.
const log = createWriteStream(path.join(home, 'core.log'), { flags: 'a' })
let child = null
let stopping = false
let failures = 0
let timer = null

function start() {
  if (stopping) return
  const started = new Date().toISOString()
  log.write(`\n[supervise-core] ${started} starting core on ${port}\n`)
  child = spawn('pnpm', ['--filter', '@conclave/core', 'run', 'dev'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { process.stdout.write(data); log.write(data) })
  child.on('exit', (code, signal) => {
    if (stopping) return
    log.write(`[supervise-core] ${new Date().toISOString()} core exited (${signal ?? code}); restarting\n`)
    console.error(`[supervise-core] core exited (${signal ?? code}); restarting`)
    child = null
    timer = setTimeout(start, 1000)
  })
}

async function probe() {
  if (stopping) return
  try {
    const response = await fetch(`http://127.0.0.1:${port}/conclave`, { signal: AbortSignal.timeout(3000) })
    failures = response.ok ? 0 : failures + 1
  } catch {
    failures++
  }
  if (failures >= 3 && child) {
    log.write(`[supervise-core] ${new Date().toISOString()} core is not answering; restarting\n`)
    console.error('[supervise-core] core is not answering; restarting it')
    failures = 0
    child.kill('SIGTERM')
  }
}

function stop() {
  stopping = true
  clearTimeout(timer)
  clearInterval(probeTimer)
  if (child) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
start()
const probeTimer = setInterval(probe, 10_000)
