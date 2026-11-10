#!/usr/bin/env node
// FreePool & Autonomous Task Ratchet Runner
// Implements Karpathy autoresearch immutable evaluation loop + Conclave environment supply protocol.
//
// Usage:
//   node scripts/run-autonomous-ratchet.mjs [--dir <repoDir>] [--max-iters <N>] [--step]
//
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const flag = (name) => args.includes(name)

const targetDir = path.resolve(option('--dir') ?? '/home/swrd/workspace/freepool')
const verifierRel = option('--verifier') ?? '.conclave/verifier.sh'
const programRel = option('--program') ?? '.conclave/program.md'
const maxIters = parseInt(option('--max-iters') ?? '10', 10)
const stepMode = flag('--step')

function git(dir, ...argv) {
  try {
    return execFileSync('git', argv, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    return (err.stdout?.toString() || err.stderr?.toString() || '').trim()
  }
}

async function sha256(filePath) {
  if (!existsSync(filePath)) return null
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

export function parseVerifierOutput(output) {
  const lines = output.split(/\r?\n/)
  let metricScore = 0
  let goalReached = false
  let passedChecks = 0
  let totalChecks = 6

  for (const line of lines) {
    const scoreMatch = /^METRIC_SCORE=([+-]?\d+(?:\.\d+)?)$/.exec(line.trim())
    if (scoreMatch) metricScore = parseFloat(scoreMatch[1])
    if (line.includes('GOAL_REACHED=true')) goalReached = true
    const summaryMatch = /Summary:\s+passed=(\d+)\/(\d+)/.exec(line)
    if (summaryMatch) {
      passedChecks = parseInt(summaryMatch[1], 10)
      totalChecks = parseInt(summaryMatch[2], 10)
    }
  }

  const tailLines = lines.slice(-30).join('\n')
  return { metricScore, goalReached, passedChecks, totalChecks, tailLines }
}

export function runVerifier(dir, verifierRelPath) {
  const verifierPath = path.join(dir, verifierRelPath)
  if (!existsSync(verifierPath)) {
    return {
      exitCode: 1,
      output: `Verifier script not found at ${verifierPath}`,
      ...parseVerifierOutput(`METRIC_SCORE=0\nVerifier not found`)
    }
  }

  const res = spawnSync('bash', [verifierRelPath], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, PATH: process.env.PATH }
  })

  const output = (res.stdout || '') + '\n' + (res.stderr || '')
  return {
    exitCode: res.status ?? 1,
    output,
    ...parseVerifierOutput(output)
  }
}

async function main() {
  console.log(`\n===============================================================`)
  console.log(`[Conclave Autonomy Ratchet] Initializing Runner`)
  console.log(`Target Repo:   ${targetDir}`)
  console.log(`Verifier:      ${verifierRel}`)
  console.log(`Program Spec:  ${programRel}`)
  console.log(`Max Iterations: ${maxIters}`)
  console.log(`===============================================================\n`)

  if (!existsSync(targetDir)) {
    console.error(`Target directory ${targetDir} does not exist.`)
    process.exit(1)
  }

  const verifierFullPath = path.join(targetDir, verifierRel)
  const lockedVerifierHash = await sha256(verifierFullPath)
  if (!lockedVerifierHash) {
    console.error(`Could not compute hash for ${verifierFullPath}. File does not exist.`)
    process.exit(1)
  }
  console.log(`[Security] Immutable Verifier locked with SHA-256: ${lockedVerifierHash}`)

  // Initial Git status check
  const isGit = existsSync(path.join(targetDir, '.git'))
  if (!isGit) {
    console.log(`[Init] Initializing git repository at ${targetDir}`)
    git(targetDir, 'init')
  }

  // Baseline evaluation
  console.log(`\n--- Running Initial Baseline Evaluation ---`)
  const baseline = runVerifier(targetDir, verifierRel)
  console.log(`Baseline Metric Score: ${baseline.metricScore}/100 (Passed: ${baseline.passedChecks}/${baseline.totalChecks})`)
  console.log(`Baseline Status: ${baseline.exitCode === 0 ? 'SUCCESS' : 'FAILED'}`)
  if (baseline.exitCode !== 0) {
    console.log(`\nFailure Details:\n${baseline.tailLines}\n`)
  }

  let bestScore = baseline.metricScore
  let bestCommit = git(targetDir, 'rev-parse', 'HEAD')
  if (bestCommit.startsWith('fatal')) bestCommit = 'INITIAL'

  console.log(`Initial Best Score: ${bestScore}, HEAD: ${bestCommit}`)

  const ledgerFile = path.join(targetDir, '.conclave', 'ledger.jsonl')
  const recordLedger = async (entry) => {
    await appendFile(ledgerFile, JSON.stringify(entry) + '\n', 'utf8')
  }

  await recordLedger({
    timestamp: new Date().toISOString(),
    iteration: 0,
    commit: bestCommit,
    score: bestScore,
    status: 'baseline',
    summary: 'Initial baseline evaluation'
  })

  console.log(`\n[Ratchet Ready] Autonomous Ratchet is primed and ready to evaluate iterations.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
