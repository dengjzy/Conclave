import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  antigravityCliAuthStateFile,
  antigravityCliTokenFile,
  antigravityHomeSignedIn,
  antigravityInstallation,
  antigravitySignedIn,
  decodeGoKeyringSecret,
  detectAntigravity,
  isSystemDefaultGeminiHome,
  readAntigravityKeyringToken,
  requireAntigravity
} from './antigravity-runtime'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function home() {
  const root = await mkdtemp(path.join(tmpdir(), 'conclave-antigravity-'))
  roots.push(root)
  return root
}

async function writeFakeAgy(dir: string, versionOutput: string, helpOutput: string): Promise<string> {
  if (process.platform === 'win32') {
    const file = path.join(dir, 'agy.cmd')
    const versionCmd = versionOutput ? `echo ${versionOutput}` : 'rem'
    const helpCmd = helpOutput ? `echo ${helpOutput}` : 'rem'
    await writeFile(file, `@echo off\r\nif "%~1"=="--version" (${versionCmd})\r\nif "%~1"=="--help" (${helpCmd})\r\n`)
    return file
  }
  const file = path.join(dir, 'agy')
  await writeFile(
    file,
    `#!/bin/sh\nif [ "$1" = "--help" ]; then\n  printf '%b' "${helpOutput}"\nelif [ "$1" = "--version" ]; then\n  printf '%b' "${versionOutput}"\nfi\n`
  )
  await chmod(file, 0o755)
  return file
}

describe('Antigravity runtime', () => {
  it('offers the official agy CLI installer on macOS, Linux, and Windows', () => {
    expect(antigravityInstallation('darwin')).toEqual({
      agent: 'antigravity',
      shell: 'bash',
      command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
    })
    expect(antigravityInstallation('linux')).toEqual({
      agent: 'antigravity',
      shell: 'bash',
      command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
    })
    expect(antigravityInstallation('win32')).toEqual({
      agent: 'antigravity',
      shell: 'powershell',
      command: 'irm https://antigravity.google/cli/install.ps1 | iex'
    })
    expect(antigravityInstallation('freebsd')).toBeNull()
  })

  it('reports missing when agy is absent or does not advertise the acp subcommand', async () => {
    const root = await home()
    const host = { platform: process.platform, arch: process.arch, home: root, pathEnv: root }
    expect(await detectAntigravity('', process.platform, host)).toEqual({ status: 'missing', version: null, path: null, signedIn: null })
    await expect(requireAntigravity(host)).rejects.toThrow(/未安装/)

    await writeFakeAgy(root, '', '')
    expect(await detectAntigravity(root, process.platform, host)).toEqual({ status: 'missing', version: null, path: null, signedIn: null })
    await expect(requireAntigravity(host)).rejects.toThrow(/未安装/)
  })

  it('flags agy versions older than 1.5.0 as incompatible', async () => {
    const root = await home()
    const cli = await writeFakeAgy(root, 'agy version 1.4.1', '')
    const host = { platform: process.platform, arch: process.arch, home: root, pathEnv: root }
    expect(await detectAntigravity(root, process.platform, host)).toEqual({
      status: 'unknown',
      version: '1.4.1',
      path: cli,
      signedIn: null,
      problem: 'incompatible-version'
    })
    await expect(requireAntigravity(host)).rejects.toMatchObject({ reason: 'antigravity-incompatible' })
  })

  it('detects and requires agy CLI (>= 1.5.0) supporting acp', async () => {
    const root = await home()
    const cli = await writeFakeAgy(
      root,
      'agy version 1.5.6\\n',
      process.platform === 'win32' ? '  acp         Run the Agent Client Protocol server' : 'Available Commands:\\n  acp         Run the Agent Client Protocol server\\n  update      Update agy\\n'
    )
    const host = { platform: process.platform, arch: process.arch, home: root, pathEnv: root }
    expect(await detectAntigravity(root, process.platform, host)).toMatchObject({ status: 'ok', version: '1.5.6', path: cli })
    expect(await requireAntigravity(host)).toBe(cli)
  })

  it('reads sign-in state from antigravity-cli token and default auth-state files', async () => {
    const gemini = await home()
    const file = antigravityCliTokenFile(gemini)
    expect(await antigravitySignedIn(file)).toBe(false)
    expect(await antigravityHomeSignedIn(gemini)).toBe(false)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{}')
    expect(await antigravitySignedIn(file)).toBe(true)
    expect(await antigravityHomeSignedIn(gemini)).toBe(true)

    const authState = antigravityCliAuthStateFile(path.join(gemini, 'other'))
    expect(await antigravityHomeSignedIn(path.dirname(path.dirname(authState)))).toBe(false)
  })

  it('decodes go-keyring secrets and reads default-home credentials on macOS and Linux keyrings', async () => {
    const payload = '{"token":{"refresh_token":"rt"}}'
    expect(decodeGoKeyringSecret(`  ${payload}\n`)).toBe(payload)
    expect(decodeGoKeyringSecret(`go-keyring-base64:${Buffer.from(payload, 'utf8').toString('base64')}`)).toBe(payload)

    const darwinCalls: { file: string; args: readonly string[] }[] = []
    expect(await readAntigravityKeyringToken('darwin', async (file, args) => {
      darwinCalls.push({ file, args })
      return `go-keyring-base64:${Buffer.from(payload, 'utf8').toString('base64')}`
    })).toBe(payload)
    expect(darwinCalls).toEqual([{ file: 'security', args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'] }])

    const linuxCalls: { file: string; args: readonly string[] }[] = []
    expect(await readAntigravityKeyringToken('linux', async (file, args) => {
      linuxCalls.push({ file, args })
      return payload
    })).toBe(payload)
    expect(linuxCalls).toEqual([{ file: 'secret-tool', args: ['lookup', 'service', 'gemini', 'username', 'antigravity'] }])

    expect(await readAntigravityKeyringToken('win32', async () => payload)).toBeNull()
    expect(await readAntigravityKeyringToken('linux', async () => { throw new Error('missing') })).toBeNull()

    expect(isSystemDefaultGeminiHome(undefined, {}, '/home/alice')).toBe(true)
    expect(isSystemDefaultGeminiHome('/home/alice/.gemini', {}, '/home/alice')).toBe(true)
    expect(isSystemDefaultGeminiHome('/tmp/isolated-account', {}, '/home/alice')).toBe(false)
    expect(isSystemDefaultGeminiHome(undefined, { GEMINI_HOME: '/tmp/test-gemini' }, '/home/alice')).toBe(false)
  })
})
