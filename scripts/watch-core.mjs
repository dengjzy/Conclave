#!/usr/bin/env node
import { spawn } from 'node:child_process'

// Keep a development core reachable without taking over an instance that is already serving.
// It starts one only after the port has been down for three probes; the child's exit clears the
// slot so the next tick can try again.
const port = process.env.CONCLAVE_PORT ?? process.env.PORT ?? '43551'
let child = null
let down = 0
let stopping = false

async function serving() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/conclave`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

async function tick() {
  if (stopping) return
  if (child && child.exitCode !== null) child = null
  if (child) return
  if (await serving()) { down = 0; return }
  down++
  if (down < 3) return
  console.error(`[watch-core] ${port} has been down; starting core`)
  down = 0
  child = spawn('pnpm', ['--filter', '@conclave/core', 'run', 'dev'], { stdio: 'inherit', env: process.env })
  child.on('exit', (code, signal) => {
    console.error(`[watch-core] core exited (${signal ?? code})`)
    child = null
  })
}

function stop() {
  stopping = true
  clearInterval(timer)
  if (child) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
const timer = setInterval(tick, 5000)
void tick()
