import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectOmp, ompCatalog, ompCompatible, ompInstallation } from './omp-cli'
import { omp } from './omp-adapter'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-omp-cli-')) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
const executable = (body: string) => writeFileSync(path.join(root, 'omp'), `#!${process.execPath}\n${body}`, { mode: 0o755 })

describe('omp CLI', () => {
  it('requires the release with the ACP session controls Conclave uses', () => {
    for (const version of [null, '17.9.0', '18.0.0', '18.18.7']) expect(ompCompatible(version)).toBe(false)
    for (const version of ['18.18.8', '18.18.9', '19.0.0']) expect(ompCompatible(version)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('distinguishes missing, obsolete, unresponsive and compatible executables', async () => {
    expect(await detectOmp(root, process.platform)).toMatchObject({ status: 'missing', path: null })
    executable("console.log('omp/18.18.7')")
    expect(await detectOmp(root, process.platform)).toMatchObject({ status: 'unknown', problem: 'incompatible-version', version: '18.18.7' })
    executable('process.exit(1)')
    expect(await detectOmp(root, process.platform)).toMatchObject({ status: 'unknown', problem: 'probe-failed' })
    executable("console.log('omp/18.18.8')")
    expect(await detectOmp(root, process.platform)).toEqual({ status: 'ok', version: '18.18.8', path: path.join(root, 'omp'), signedIn: null })
  })

  it.skipIf(process.platform === 'win32')('reads the models its credentials reach and marks the default role', async () => {
    executable(`
      const args = process.argv.slice(2)
      if (args[0] === '--version') console.log('omp/18.18.8')
      else if (args[0] === 'models') console.log(JSON.stringify({ models: [
        { kind: 'chat', id: 'deepseek-flash', selector: 'deepseek/deepseek-flash', name: 'DeepSeek Flash', reasoning: true, thinking: ['low', 'high', 'max'] },
        { kind: 'chat', id: 'deepseek-v4-pro', selector: 'deepseek/deepseek-v4-pro', name: 'DeepSeek Pro', reasoning: true, thinking: ['high'] },
        { kind: 'embedding', id: 'embed', selector: 'deepseek/embed', name: 'Embed', reasoning: false, thinking: [] }
      ] }))
      else if (args[0] === 'config') console.log(JSON.stringify({ default: 'deepseek/deepseek-flash:max' }))
    `)
    vi.stubEnv('PATH', root)
    expect(await ompCatalog(root)).toEqual({ models: [
      { id: 'deepseek/deepseek-flash', label: 'DeepSeek Flash', description: null, efforts: ['low', 'high', 'max'], isDefault: true },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek Pro', description: null, efforts: ['high'], isDefault: false }
    ] })
  })

  it.skipIf(process.platform === 'win32')('returns no catalog for output it cannot read', async () => {
    executable(`
      const args = process.argv.slice(2)
      if (args[0] === '--version') console.log('omp/18.18.8')
      else console.log('not json')
    `)
    vi.stubEnv('PATH', root)
    expect(await ompCatalog(root)).toBeNull()
  })

  it('offers the official installer and configures ACP with Conclave\u2019s approval boundary', () => {
    expect(ompInstallation('win32')).toMatchObject({ shell: 'powershell', command: 'irm https://omp.sh/install.ps1 | iex' })
    expect(ompInstallation('darwin')).toMatchObject({ shell: 'bash', command: 'curl -fsSL https://omp.sh/install | sh' })
    const base = { providerSessionId: null, resume: false, handoffPath: null, extraProjects: [] }
    expect(omp.command(base)).toEqual({ command: 'omp', args: ['acp', '--approval-mode', 'write'] })
    expect(omp.command({ ...base, extraProjects: ['/extra'], knowledgeBase: { path: '/vault', write: true } })).toEqual({
      command: 'omp',
      args: ['acp', '--approval-mode', 'write', '--add-dir', '/extra', '--add-dir', '/vault']
    })
    expect(omp.command({ ...base, knowledgeBase: { path: '/vault', write: false } }).args).toEqual(['acp', '--approval-mode', 'write'])
    expect(omp.session.nativeFork).toBe('none')
    expect(omp.permissionModes).toEqual(['acceptEdits'])
  })
})
