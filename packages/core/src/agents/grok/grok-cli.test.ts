import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectGrok, grokCompatible, grokInstallation, grokSignedIn } from './grok-cli'
import { grok } from './grok-adapter'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-grok-cli-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const executable = (body: string) => writeFileSync(path.join(root, 'grok'), `#!${process.execPath}\n${body}`, { mode: 0o755 })

describe('Grok CLI', () => {
  it('requires Grok 1.0.70 or later for ACP stdio support', () => {
    for (const version of [null, '0.9.0', '0.99.1', '1.0.0', '1.0.69']) expect(grokCompatible(version)).toBe(false)
    for (const version of ['1.0.70', '1.1.0', '2.0.0']) expect(grokCompatible(version)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('distinguishes missing, obsolete, unresponsive and compatible executables', async () => {
    expect(await detectGrok(root, process.platform)).toMatchObject({ status: 'missing', path: null })
    executable("console.log('grok 0.9.0')")
    expect(await detectGrok(root, process.platform)).toMatchObject({ status: 'unknown', problem: 'incompatible-version', version: '0.9.0' })
    executable('process.exit(1)')
    expect(await detectGrok(root, process.platform)).toMatchObject({ status: 'unknown', problem: 'probe-failed' })
    executable("console.log('1.0.70')")
    expect(await detectGrok(root, process.platform)).toMatchObject({ status: 'ok', version: '1.0.70', path: path.join(root, 'grok') })
  })

  it('detects signed-in status via environment variable or auth.json in grokHome', async () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'conclave-grok-auth-'))
    try {
      expect(await grokSignedIn({ GROK_API_KEY: '', GROK_DEPLOYMENT_KEY: '', XAI_API_KEY: '', GROK_HOME: fakeHome })).toBe(false)
      expect(await grokSignedIn({ GROK_API_KEY: 'test-api-key', GROK_DEPLOYMENT_KEY: '', XAI_API_KEY: '', GROK_HOME: fakeHome })).toBe(true)
      expect(await grokSignedIn({ GROK_DEPLOYMENT_KEY: 'test-key', XAI_API_KEY: '', GROK_HOME: fakeHome })).toBe(true)
      expect(await grokSignedIn({ GROK_DEPLOYMENT_KEY: '', XAI_API_KEY: 'test-api-key', GROK_HOME: fakeHome })).toBe(true)
      writeFileSync(path.join(fakeHome, 'auth.json'), '{}')
      expect(await grokSignedIn({ GROK_DEPLOYMENT_KEY: '', XAI_API_KEY: '', GROK_HOME: fakeHome })).toBe(true)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('offers the official installer on each platform and configures agent stdio launch', async () => {
    expect(grokInstallation('win32')).toMatchObject({ shell: 'powershell', command: 'irm https://x.ai/cli/install.ps1 | iex' })
    expect(grokInstallation('darwin').shell).toBe('bash')
    expect(grokInstallation('linux').shell).toBe('bash')
    expect(grok.command({ providerSessionId: null, resume: false, handoffPath: null, extraProjects: ['/extra/path'] })).toEqual({
      command: 'grok',
      args: ['agent', 'stdio', '--no-auto-update']
    })
    expect(grok.session.nativeFork).toBe('none')
    expect(await grok.signedIn?.(root)).toBe(false)
  })
})
