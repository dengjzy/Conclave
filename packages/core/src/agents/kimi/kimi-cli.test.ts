import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectKimi, kimiCompatible, kimiInstallation } from './kimi-cli'
import { kimi } from './kimi-adapter'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-kimi-cli-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const executable = (body: string) => writeFileSync(path.join(root, 'kimi'), `#!${process.execPath}\n${body}`, { mode: 0o755 })

describe('Kimi Code CLI', () => {
  it('requires the verified Node.js ACP release rather than legacy Python kimi-cli', () => {
    for (const version of [null, '0.90.0', '1.0.0', '2.3.1']) expect(kimiCompatible(version)).toBe(false)
    for (const version of ['2.3.2', '2.4.0', '3.0.0']) expect(kimiCompatible(version)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('distinguishes missing, obsolete, unresponsive and compatible executables without claiming a sign-in', async () => {
    expect(await detectKimi(root, process.platform)).toMatchObject({ status: 'missing', path: null })
    executable("console.log('kimi, version 0.90.0')")
    expect(await detectKimi(root, process.platform)).toMatchObject({ status: 'unknown', problem: 'incompatible-version', version: '0.90.0' })
    executable('process.exit(1)')
    expect(await detectKimi(root, process.platform)).toMatchObject({ status: 'unknown', problem: 'probe-failed' })
    executable("console.log('2.3.2')")
    expect(await detectKimi(root, process.platform)).toEqual({ status: 'ok', version: '2.3.2', path: path.join(root, 'kimi'), signedIn: null })
  })

  it('offers the official npm package on each platform and starts ACP without shell flags or a prompt', () => {
    expect(kimiInstallation('win32')).toMatchObject({ shell: 'powershell', command: 'npm install -g @moonshot-ai/kimi-code@latest' })
    expect(kimiInstallation('darwin').shell).toBe('bash')
    expect(kimiInstallation('linux').shell).toBe('bash')
    expect(kimi.command({ providerSessionId: null, resume: false, handoffPath: null, extraProjects: [] })).toEqual({ command: 'kimi', args: ['acp'] })
    // Its native fork retains the source MCP servers; Conclave must create a scoped handoff instead.
    expect(kimi.session.nativeFork).toBe('none')
  })
})
