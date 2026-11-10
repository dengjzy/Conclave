#!/usr/bin/env node
// The friction list a self-evolution generation works from. A item is only valid with a repro:
// without one the loop cannot tell whether the fix worked.
//
//   node scripts/self-friction.mjs add --summary "..." --repro "..." --expect "..." [--paths a,b]
//   node scripts/self-friction.mjs list [--all]
//   node scripts/self-friction.mjs next
//   node scripts/self-friction.mjs update <id> <open|doing|done|dropped>
//
// Kept under the Conclave home (CONCLAVE_HOME/self/friction.json): user data, not repository data.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const home = process.env.CONCLAVE_HOME ?? path.join(os.homedir(), '.conclave')
const file = path.join(home, 'self', 'friction.json')

const args = process.argv.slice(2)
const command = args[0] ?? 'list'
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const flag = (name) => args.includes(name)

async function load() {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
}

async function save(items) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`)
  await rename(temporary, file)
}

function id(summary) {
  const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return slug || `f-${createHash('sha1').update(summary).digest('hex').slice(0, 8)}`
}

function require_(value, name) {
  if (!value || !value.trim()) {
    console.error(`self-friction: --${name} is required`)
    process.exit(2)
  }
  return value.trim()
}

const items = await load()
if (command === 'add') {
  const summary = require_(option('--summary'), 'summary')
  const repro = require_(option('--repro'), 'repro')
  const expect = require_(option('--expect'), 'expect')
  const idValue = option('--id') ?? id(summary)
  if (items.some((item) => item.id === idValue)) {
    console.error(`self-friction: ${idValue} already exists`)
    process.exit(1)
  }
  const now = new Date().toISOString()
  const item = {
    id: idValue,
    summary,
    repro,
    expect,
    paths: (option('--paths') ?? '').split(',').map((each) => each.trim()).filter(Boolean),
    status: 'open',
    createdAt: now,
    updatedAt: now
  }
  items.push(item)
  await save(items)
  console.log(`added ${item.id}`)
} else if (command === 'list') {
  const shown = flag('--all') ? items : items.filter((item) => item.status !== 'done' && item.status !== 'dropped')
  if (shown.length === 0) console.log('no friction items')
  for (const item of shown) console.log(`${item.status.padEnd(7)} ${item.id.padEnd(24)} ${item.summary}`)
} else if (command === 'next') {
  const next = items.find((item) => item.status === 'open')
  console.log(next ? JSON.stringify(next, null, 2) : '')
  if (!next) process.exit(1)
} else if (command === 'update') {
  const [, idValue, status] = args
  const item = items.find((each) => each.id === idValue)
  if (!item) {
    console.error(`self-friction: no ${idValue}`)
    process.exit(1)
  }
  if (!['open', 'doing', 'done', 'dropped'].includes(status)) {
    console.error('self-friction: status must be open, doing, done or dropped')
    process.exit(2)
  }
  item.status = status
  item.updatedAt = new Date().toISOString()
  await save(items)
  console.log(`${item.id} ${status}`)
} else {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
