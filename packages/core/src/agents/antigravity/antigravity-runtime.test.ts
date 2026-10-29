import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ANTIGRAVITY_VERSION, antigravityInstallation, antigravityRuntimeDir, antigravitySignedIn, antigravityTokenFile, detectAntigravity, requireAntigravity } from './antigravity-runtime'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function home() {
  const root = await mkdtemp(path.join(tmpdir(), 'conclave-antigravity-'))
  roots.push(root)
  return root
}

describe('Antigravity runtime', () => {
  it('downloads the pinned archive, checks its hash and renames it into place', () => {
    const host = { platform: 'darwin' as const, arch: 'arm64', home: "/Users/o'neil/.conclave" }
    const install = antigravityInstallation('darwin', host)
    expect(install?.shell).toBe('bash')
    expect(install?.command).toContain(`curl -fL --progress-bar 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-${ANTIGRAVITY_VERSION}-darwin-arm64.zip'`)
    expect(install?.command).toContain('f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17  $z" | shasum -a 256 -c')
    expect(install?.command).toContain(`d='/Users/o'\\''neil/.conclave/runtimes/antigravity-acp/${ANTIGRAVITY_VERSION}'`)
    expect(install?.command).toMatch(/unzip -q "\$z" -d "\$d\.partial" && rm -rf "\$d" && mv "\$d\.partial" "\$d"/)
    expect(antigravityInstallation('linux', { ...host, platform: 'linux', arch: 'x64' })?.command).toContain('| sha256sum -c')
    expect(antigravityInstallation('freebsd', { ...host, platform: 'freebsd' })).toBeNull()
  })

  it('is found only once its server and harness are both in place', async () => {
    const host = { platform: 'darwin' as const, arch: 'arm64', home: await home() }
    expect(await detectAntigravity('', 'darwin', host)).toEqual({ status: 'missing', version: null, path: null, signedIn: null })
    await expect(requireAntigravity(host)).rejects.toThrow(/未安装/)
    const dir = antigravityRuntimeDir(host)
    await mkdir(dir, { recursive: true })
    const server = path.join(dir, 'agy_acp_server.par')
    await writeFile(server, '')
    await chmod(server, 0o755)
    expect((await detectAntigravity('', 'darwin', host)).status).toBe('missing')
    await writeFile(path.join(dir, 'localharness_external'), '')
    expect(await detectAntigravity('', 'darwin', host)).toMatchObject({ status: 'ok', version: ANTIGRAVITY_VERSION, path: server })
    expect(await requireAntigravity(host)).toBe(server)
    await expect(requireAntigravity({ ...host, arch: 'ia32' })).rejects.toThrow(/不支持/)
  })

  it('reads a sign-in kept in its token file', async () => {
    const gemini = await home()
    const file = antigravityTokenFile(gemini)
    expect(await antigravitySignedIn(file)).toBe(false)
    await mkdir(path.dirname(file))
    await writeFile(file, '{}')
    expect(await antigravitySignedIn(file)).toBe(true)
  })
})
