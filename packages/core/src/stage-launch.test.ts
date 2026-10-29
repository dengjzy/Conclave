import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foldersInUse, launchDir, launchLeftovers, onlyGrantedTo, parseWhoami, privateDir, removeLaunch, writePrivateFile } from './stage-launch'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-launch-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const stage = (stageId = 's1') => ({ sessionsRoot: root, conversationId: 'c1', stageId })
const mode = (file: string) => statSync(file).mode & 0o777

describe('a stage launch folder', () => {
  it.skipIf(process.platform === 'win32')('is the user\'s alone, an old one made so too, its files written once', async () => {
    const dir = launchDir(stage())
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    await privateDir(dir)
    expect(mode(dir)).toBe(0o700)
    const file = path.join(dir, 'provider.json')
    await writePrivateFile(file, '{"key":"sk"}')
    expect(mode(file)).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe('{"key":"sk"}')
    // One already there may be another process's: never written over.
    await expect(writePrivateFile(file, 'other')).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{"key":"sk"}')
  })

  it.skipIf(process.platform === 'win32')('refuses a link in its place', async () => {
    const elsewhere = path.join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const dir = launchDir(stage())
    mkdirSync(path.dirname(dir), { recursive: true })
    symlinkSync(elsewhere, dir)
    await expect(privateDir(dir)).rejects.toThrow(/不是普通文件夹/)
  })

  it('on Windows, takes inheritance off and grants the user alone, or refuses', async () => {
    const dir = path.join(root, 'w')
    const calls: string[][] = []
    const listing = (who: string) => `${dir} ${who}:(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`
    const run = (printed: string) => async (file: string, args: readonly string[]) => {
      calls.push([file, ...args])
      if (file === 'whoami') return '"desktop-1\\ann","S-1-5-21-1-2-3-1001"\r\n'
      return args.length === 1 ? printed : 'processed file'
    }
    await privateDir(dir, 'win32', run(listing('DESKTOP-1\\ann')))
    expect(calls).toContainEqual(['icacls', dir, '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(OI)(CI)F'])
    await expect(privateDir(dir, 'win32', run(`${listing('DESKTOP-1\\ann')}${dir} BUILTIN\\Users:(RX)\n`))).rejects.toThrow(/只有当前用户/)
    await expect(privateDir(dir, 'win32', async () => { throw new Error('no whoami') })).rejects.toThrow(/读不到当前 Windows 用户/)
  })

  it('reads the account and icacls listings', () => {
    expect(parseWhoami('"pc\\ann","S-1-5-21-9-1001"\r\n')).toEqual({ name: 'pc\\ann', sid: 'S-1-5-21-9-1001' })
    expect(parseWhoami('')).toBeNull()
    const account = { name: 'pc\\ann', sid: 'S-1-5-21-9-1001' }
    expect(onlyGrantedTo('C:\\x PC\\ann:(OI)(CI)(F)\n', 'C:\\x', account)).toBe(true)
    expect(onlyGrantedTo('C:\\x S-1-5-21-9-1001:(OI)(CI)(F)\n', 'C:\\x', account)).toBe(true)
    expect(onlyGrantedTo('C:\\x PC\\ann:(F)\n    NT AUTHORITY\\SYSTEM:(F)\n', 'C:\\x', account)).toBe(false)
    expect(onlyGrantedTo('Successfully processed 0 files', 'C:\\x', account)).toBe(false)
  })

  it('lists what stages left, and removes one', async () => {
    mkdirSync(launchDir(stage('s1')), { recursive: true })
    mkdirSync(launchDir(stage('s2')), { recursive: true })
    writeFileSync(path.join(root, 'c1', 'chat.jsonl'), '')
    expect((await launchLeftovers(root)).map((left) => left.stageId).sort()).toEqual(['s1', 's2'])
    await removeLaunch(stage('s1'))
    expect((await launchLeftovers(root)).map((left) => left.stageId)).toEqual(['s2'])
    expect(await launchLeftovers(path.join(root, 'missing'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('fails a look it could not take, rather than finding nothing', async () => {
    mkdirSync(launchDir(stage('s1')), { recursive: true })
    chmodSync(path.join(root, 'c1', 'launch'), 0o000)
    try {
      await expect(launchLeftovers(root)).rejects.toThrow()
    } finally {
      chmodSync(path.join(root, 'c1', 'launch'), 0o700)
    }
  })

  it('finds the folders a running process names in its environment, where the platform shows them', async () => {
    const printed = '/usr/bin/zcode app-server --stdio HOME=/Users/a ZCODE_DATA_BASE_DIR=/s/c1/launch/s1 PATH=/bin\n/bin/zsh -l TERM=xterm\n'
    expect(await foldersInUse(['/s/c1/launch/s1', '/s/c1/launch/s2'], 'darwin', async () => printed)).toEqual(new Set(['/s/c1/launch/s1']))
    expect(await foldersInUse(['/s/c1/launch/s1'], 'darwin', async () => { throw new Error('no ps') })).toBeNull()
    expect(await foldersInUse(['/s/c1/launch/s1'], 'win32')).toBeNull()
    expect(await foldersInUse([], 'win32')).toEqual(new Set())
  })
})
