import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareDshProfile } from './dsh-cli'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(failOnce = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'conclave-dsh-install-'))
  roots.push(root)
  const command = path.join(root, 'dsh')
  const home = path.join(root, 'home')
  const bundle = path.join(root, 'runtime.tgz')
  await writeFile(bundle, 'test-bundle')
  await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const profile = path.join(process.env.DSH_HOME, 'profiles', 'conclave')
fs.mkdirSync(profile, {recursive:true})
const calls = path.join(profile, 'calls')
const count = Number(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : 0) + 1
fs.writeFileSync(calls, String(count))
if (process.argv.slice(2).join('|') !== ['plugin', '--profile', 'conclave', 'add', ${JSON.stringify(bundle)}].join('|')) process.exit(2)
if (${failOnce} && count === 1) process.exit(1)
const install = path.join(profile, 'node_modules', '@conclave', 'dsh-runtime')
fs.mkdirSync(install, {recursive:true})
fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({name:'@conclave/dsh-runtime'}))
`, { mode: 0o700 })
  return { root, home, command, bundle, profile: path.join(home, 'profiles', 'conclave') }
}

describe.skipIf(process.platform === 'win32')('DSH managed profile', () => {
  it('coalesces concurrent preparation, skips the installed digest, and reinstalls a changed bundle', async () => {
    const f = await fixture()
    await Promise.all([prepareDshProfile(f.command, f.bundle, f.home), prepareDshProfile(f.command, f.bundle, f.home)])
    expect(await readFile(path.join(f.profile, 'calls'), 'utf8')).toBe('1')
    await prepareDshProfile(f.command, f.bundle, f.home)
    expect(await readFile(path.join(f.profile, 'calls'), 'utf8')).toBe('1')
    await writeFile(f.bundle, 'updated-bundle')
    await prepareDshProfile(f.command, f.bundle, f.home)
    expect(await readFile(path.join(f.profile, 'calls'), 'utf8')).toBe('2')
  })

  it('can retry an installation failure and preserves files already in the profile', async () => {
    const f = await fixture(true)
    await mkdir(f.profile, { recursive: true })
    const existing = path.join(f.profile, 'cordis.patch.yml')
    await writeFile(existing, 'user-config')
    await expect(prepareDshProfile(f.command, f.bundle, f.home)).rejects.toMatchObject({ reason: 'dsh-runtime-install-failed' })
    await prepareDshProfile(f.command, f.bundle, f.home)
    expect(await readFile(existing, 'utf8')).toBe('user-config')
  })
})
