#!/usr/bin/env node
// One self-evolution generation: take the next friction item, run it as an autonomous task in its
// own worktree, and fast-forward self/evolve when every gate passed. It never touches main and
// never pushes; promotion from self/evolve is a person's decision.
//
//   node scripts/self-evolve.mjs --id stale-web-bundle [--agent dsh] [--no-merge] [--dry-run]
//
// The gates are the task's contract checks, so core runs them, records their output and retries
// exactly as it does for any other task. A generation that cannot start, or whose suite shrinks,
// stops at the contract and leaves the task for a person to read.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HOME = process.env.CONCLAVE_HOME ?? path.join(os.homedir(), '.conclave')
const SELF = path.join(HOME, 'self')
const POLL_MS = 5000

const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const flag = (name) => args.includes(name)
const frictionId = option('--id')
const agent = option('--agent') ?? 'dsh'
const merge = !flag('--no-merge')
const dryRun = flag('--dry-run')

const git = (...argv) => execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' }).trim()
const isAncestor = (ancestor, descendant) => spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: ROOT }).status === 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message) {
  console.error(`self-evolve: ${message}`)
  process.exit(1)
}

async function readFriction(id) {
  const items = JSON.parse(await readFile(path.join(SELF, 'friction.json'), 'utf8'))
  return items.find((item) => item.id === id) ?? null
}

function connect(core) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${core.port}/?token=${core.token}`)
    const pending = new Map()
    let next = 0
    const call = (method, params = {}) => new Promise((done, failed) => {
      const id = ++next
      pending.set(id, { done, failed })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.failed(new Error(`${message.error.message}${message.error.data?.reason ? ` (${message.error.data.reason})` : ''}`))
      else waiter.done(message.result)
    })
    socket.addEventListener('error', () => reject(new Error('cannot reach the running core')))
    socket.addEventListener('open', () => resolve({ call, close: () => socket.close() }))
  })
}

const friction = frictionId ? await readFriction(frictionId) : null
if (!friction) fail(`no friction "${frictionId ?? ''}"; run node scripts/self-friction.mjs list`)
if (friction.status !== 'open' && friction.status !== 'doing') fail(`${friction.id} is ${friction.status}`)

// A generation must not carry someone's uncommitted work into its base, and the host must be the
// checkout this script is run from.
if (git('status', '--porcelain')) fail('the worktree has uncommitted changes; commit or stash them first')
const base = git('rev-parse', 'self/evolve')
const baseShort = base.slice(0, 8)

const checks = [
  { repo: ROOT, command: 'pnpm typecheck', timeoutMs: 600_000, required: true },
  { repo: ROOT, command: 'pnpm test', timeoutMs: 900_000, required: true },
  { repo: ROOT, command: 'pnpm build', timeoutMs: 600_000, required: true },
  { repo: ROOT, command: 'pnpm self:smoke', timeoutMs: 180_000, required: true },
  { repo: ROOT, command: `node scripts/self-test-policy.mjs --base ${base}`, timeoutMs: 120_000, required: true }
]

const details = [
  `摩擦：${friction.summary}`,
  `复现：${friction.repro}`,
  `期望：${friction.expect}`,
  friction.paths?.length ? `允许改动的路径：${friction.paths.join('、')}` : '',
  '要求：',
  '- 先复现，再改；改完自己跑 pnpm typecheck 和 pnpm test。',
  '- 测试可以改，但不许删测试、减用例或加 skip：self:tests 会因此判负。',
  '- 不要改 .conclave/project.json 的 setup，不要动和这条摩擦无关的文件。',
  '- 保持改动小；这是一个自举代，评审看的是能不能安全合入。'
].filter(Boolean).join('\n')

if (dryRun) {
  console.log(`self-evolve: would run ${friction.id} on ${agent} from self/evolve ${baseShort}`)
  console.log(checks.map((check) => `  gate: ${check.command}`).join('\n'))
  console.log(details)
  process.exit(0)
}

const frictionCli = (status) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/self-friction.mjs'), 'update', friction.id, status], { cwd: ROOT, stdio: 'ignore' })
frictionCli('doing')

const core = JSON.parse(await readFile(path.join(HOME, 'core.json'), 'utf8'))
const { call, close } = await connect(core)

try {
  const task = await call('tasks.create', {
    title: `self: ${friction.summary}`.slice(0, 200),
    details,
    repos: [ROOT],
    agent,
    dependsOn: []
  })
  await call('tasks.update', { id: task.id, starts: [{ path: ROOT, ref: 'refs/heads/self/evolve' }] })
  await call('tasks.setContract', {
    id: task.id,
    contract: {
      goal: friction.expect,
      verification: { checks, baseline: [], criteria: [], human: [], unknowns: [] },
      constraints: { maxAttempts: 2, maxWallClockMs: 45 * 60_000 },
      risk: 'medium',
      autonomy: 'confirm'
    }
  })
  const flow = await call('flows.start', { id: task.id })
  console.log(`self-evolve: ${flow.id} running ${friction.id} on ${agent} from ${baseShort}`)

  const deadline = Date.now() + 50 * 60_000
  let state = flow.state
  while (state === 'running' && Date.now() < deadline) {
    await sleep(POLL_MS)
    state = (await call('flows.get', { id: flow.id })).state
  }
  const finished = await call('flows.get', { id: flow.id })

  if (state !== 'review') {
    console.log(`self-evolve: ${state} · ${finished.note ?? 'no note'}`)
    console.log(finished.report ?? '')
    process.exit(state === 'paused' || state === 'failed' ? 1 : 2)
  }

  const ran = await call('tasks.get', { id: task.id })
  const repo = ran.repos.find((entry) => !entry.reference) ?? ran.repos[0]
  if (!repo?.branch || !repo.worktreePath) fail('the task has no branch or worktree to merge')
  const branch = repo.branch
  // A task hands its work in as a dirty worktree; the gates already ran on exactly these files,
  // so the commit the loop makes is the tree that passed.
  if (git('-C', repo.worktreePath, 'status', '--porcelain')) {
    git('-C', repo.worktreePath, 'add', '-A')
    git('-C', repo.worktreePath, 'commit', '-m', `self(${friction.id}): ${friction.summary}`)
  }
  const tip = git('-C', repo.worktreePath, 'rev-parse', 'HEAD')
  if (!isAncestor(base, tip)) fail('the generation is not based on self/evolve')
  if (git('rev-list', '--count', `${base}..${tip}`) === '0') fail('the generation made no commits')

  const report = {
    friction: friction.id,
    taskId: task.id,
    flowId: flow.id,
    agent,
    base,
    branch,
    tip,
    checks,
    note: finished.note,
    report: finished.report,
    testAuthor: finished.testAuthor,
    redFirst: finished.redFirst,
    hiddenTests: finished.hiddenTests?.files.length ?? 0,
    merged: false,
    at: new Date().toISOString()
  }

  if (merge) {
    if (git('status', '--porcelain')) fail('the worktree changed during the run; not merging')
    if (!isAncestor('self/evolve', tip)) fail('self/evolve moved during the run; re-run the gates')
    git('branch', '-f', 'self/evolve', tip)
    report.merged = true
    frictionCli('done')
  }

  await mkdir(path.join(SELF, 'generations'), { recursive: true })
  const file = path.join(SELF, 'generations', `${friction.id}-${Date.now()}.json`)
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`self-evolve: review · ${branch} ${tip.slice(0, 8)} · ${merge ? 'fast-forwarded self/evolve' : 'not merged'}`)
  console.log(`self-evolve: report ${file}`)
  console.log('self-evolve: read the diff, then promote self/evolve into main when it reads well')
} finally {
  close()
}
