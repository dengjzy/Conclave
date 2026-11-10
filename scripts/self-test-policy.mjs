#!/usr/bin/env node
// What a generation did to the test suite. Tests may be edited when the change needs it, so this
// reports rather than forbids — but a suite that silently gets smaller or skips more is how an
// agent passes its own work, and that is a failed gate.
//
//   node scripts/self-test-policy.mjs --base <sha> [--candidate <ref>] [--json]
//
// Fails when a test file is deleted, a test file loses tests, or it gains skips/todos.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const base = option('--base')
const candidate = option('--candidate') ?? 'HEAD'
const json = args.includes('--json')
if (!base) {
  console.error('self-test-policy: --base <sha> is required')
  process.exit(2)
}

const git = (...argv) => execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' })
const readAt = (ref, file) => {
  try {
    return git('show', `${ref}:${file}`)
  } catch {
    return null
  }
}

const TESTS = /\b(?:it|test)(?:\.(?:each|concurrent))?\s*\(/g
const SKIPS = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/g
const count = (text, pattern) => (text.match(pattern) ?? []).length

const changes = git('diff', '--name-status', `${base}..${candidate}`)
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t'))
  .filter(([, file]) => file && (file.endsWith('.test.ts') || file.endsWith('.test.tsx')))

const report = []
const failures = []
for (const [status, file, renamedFrom] of changes) {
  const before = status === 'A' ? null : readAt(base, status === 'R' ? renamedFrom : file)
  const after = status === 'D' ? null : readAt(candidate, file)
  const entry = { file, status, before: before ? { tests: count(before, TESTS), skips: count(before, SKIPS) } : null, after: after ? { tests: count(after, TESTS), skips: count(after, SKIPS) } : null }
  report.push(entry)
  if (status === 'D') { failures.push(`${file} was deleted`); continue }
  if (entry.before && entry.after) {
    if (entry.after.tests < entry.before.tests) failures.push(`${file}: ${entry.before.tests} → ${entry.after.tests} tests`)
    if (entry.after.skips > entry.before.skips) failures.push(`${file}: ${entry.before.skips} → ${entry.after.skips} skipped`)
  }
}

if (json) {
  console.log(JSON.stringify({ base, candidate, changes: report, failures }, null, 2))
} else {
  console.log(`self-test-policy: ${failures.length === 0 ? 'ok' : 'failed'} · ${report.length} test file(s) changed vs ${base.slice(0, 8)}`)
  for (const entry of report) {
    const before = entry.before ? `${entry.before.tests} tests / ${entry.before.skips} skipped` : 'new'
    const after = entry.after ? `${entry.after.tests} tests / ${entry.after.skips} skipped` : 'deleted'
    console.log(`  ${entry.status} ${entry.file}: ${before} → ${after}`)
  }
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  if (report.length > 0 && failures.length === 0) console.log('  edited tests are allowed when the change needs it; a person reads them before promotion')
}
process.exit(failures.length === 0 ? 0 : 1)
