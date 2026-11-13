import { execFile } from 'node:child_process'
import { access, constants, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AgentCliInstallation } from '@conclave/protocol'
import { conclaveHome, launchFile } from '@conclave/protocol/node'
import { Rejection } from '../../rejection'
import type { AgentDetection } from '../agent-adapter'

const execute = promisify(execFile)

export const AGY_MINIMUM_VERSION = '1.5.0'
const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:'

export type KeyringExec = (file: string, args: readonly string[]) => Promise<string>

const execKeyringCommand: KeyringExec = async (file, args) => {
  const { stdout } = await execute(file, [...args], { timeout: 3_000, maxBuffer: 64 * 1024, windowsHide: true })
  return stdout
}

export function decodeGoKeyringSecret(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)) return trimmed
  return Buffer.from(trimmed.slice(GO_KEYRING_BASE64_PREFIX.length), 'base64').toString('utf8').trim()
}

export function isSystemDefaultGeminiHome(geminiHome?: string, env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): boolean {
  const systemDefault = path.resolve(userHome, '.gemini')
  if (env.GEMINI_HOME && path.resolve(env.GEMINI_HOME) !== systemDefault) return false
  return !geminiHome || path.resolve(geminiHome) === systemDefault
}

export async function readAntigravityKeyringToken(
  platform: NodeJS.Platform = process.platform,
  run: KeyringExec = execKeyringCommand
): Promise<string | null> {
  try {
    const stdout = platform === 'darwin'
      ? await run('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'])
      : platform === 'linux'
        ? await run('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'])
        : ''
    const decoded = decodeGoKeyringSecret(stdout)
    return decoded || null
  } catch {
    return null
  }
}

export type Host = { platform: NodeJS.Platform; arch: string; home: string; pathEnv?: string }

function defaultPathEnv(platform: NodeJS.Platform = process.platform, userHome = homedir()): string {
  const delimiter = platform === 'win32' ? ';' : ':'
  const current = process.env.PATH ?? ''
  const extra = platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA ?? path.join(userHome, 'AppData', 'Local'), 'agy', 'bin')]
    : [path.join(userHome, '.local', 'bin'), '/usr/local/bin']
  return [current, ...extra].filter(Boolean).join(delimiter)
}

const thisHost = (): Host => ({ platform: process.platform, arch: process.arch, home: conclaveHome(), pathEnv: defaultPathEnv() })

function parseVersion(raw: string): readonly [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parsed = parseVersion(version)
  const target = parseVersion(minimum)
  if (!parsed || !target) return false
  const [pa, pb, pc] = parsed
  const [ta, tb, tc] = target
  if (pa !== ta) return pa > ta
  if (pb !== tb) return pb > tb
  return pc >= tc
}

type CachedCliProbe = {
  acpSupported: boolean
  version: string | null
  compatible: boolean
}
const cliProbeCache = new Map<string, CachedCliProbe>()

async function runReadOnly(file: string, args: readonly string[]): Promise<string> {
  try {
    const launch = launchFile(file, args, process.env)
    const { stdout, stderr } = await execute(launch.file, launch.args, {
      env: launch.env,
      timeout: 4_000,
      maxBuffer: 128 * 1024,
      windowsHide: true
    })
    return `${stdout}\n${stderr}`
  } catch (error) {
    if (error && typeof error === 'object') {
      const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
      const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
      if (stdout || stderr) return `${stdout}\n${stderr}`
    }
    return ''
  }
}

type ProbeResult =
  | { status: 'missing' }
  | { status: 'ok'; file: string; version: string | null }
  | { status: 'incompatible'; file: string; version: string | null }

export async function probeAgyCli(pathEnv: string | undefined, platform: NodeJS.Platform = process.platform): Promise<ProbeResult> {
  if (!pathEnv?.trim()) return { status: 'missing' }
  const sep = platform === 'win32' ? ';' : ':'
  const names = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'] : ['agy']
  const mode = platform === 'win32' ? constants.F_OK : constants.X_OK
  const seen = new Set<string>()
  let incompatible: ProbeResult | null = null

  for (const rawDir of pathEnv.split(sep)) {
    const dir = rawDir.trim()
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    for (const name of names) {
      const candidate = path.join(dir, name)
      const info = await stat(candidate).catch(() => null)
      if (!info?.isFile()) continue
      const executable = await access(candidate, mode).then(() => true, () => false)
      if (!executable) continue
      const cacheKey = `${candidate}:${Math.trunc(info.mtimeMs)}:${info.size}`
      let probed = cliProbeCache.get(cacheKey)
      if (!probed) {
        const help = await runReadOnly(candidate, ['--help'])
        const acpSupported = /^\s+acp\s+/m.test(help)
        const versionText = await runReadOnly(candidate, ['--version'])
        const version = /\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/.exec(versionText)?.[0] ?? null
        const compatible = acpSupported && (!version || versionAtLeast(version, AGY_MINIMUM_VERSION))
        probed = { acpSupported, version, compatible }
        cliProbeCache.set(cacheKey, probed)
      }
      if (probed.compatible) return { status: 'ok', file: candidate, version: probed.version }
      if (!incompatible && probed.version) {
        incompatible = { status: 'incompatible', file: candidate, version: probed.version }
      }
    }
  }
  return incompatible ?? { status: 'missing' }
}

export async function antigravityCliVersion(pathEnv: string = defaultPathEnv(), platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const probe = await probeAgyCli(pathEnv, platform)
  return probe.status === 'ok' || probe.status === 'incompatible' ? probe.version : null
}

export function antigravityCliTokenFile(geminiHome = process.env.GEMINI_HOME || path.join(homedir(), '.gemini')): string {
  return path.join(geminiHome, 'antigravity-cli', 'antigravity-oauth-token')
}

export function antigravityCliAuthStateFile(geminiHome = process.env.GEMINI_HOME || path.join(homedir(), '.gemini')): string {
  return path.join(geminiHome, 'antigravity-cli', 'cache', 'acp-auth-state.json')
}

export async function antigravitySignedIn(file = antigravityCliTokenFile()): Promise<boolean> {
  try {
    const content = (await readFile(file, 'utf8')).trim()
    return content.length > 0
  } catch {
    return false
  }
}

export async function antigravityHomeSignedIn(geminiHome?: string): Promise<boolean> {
  const defaultHome = process.env.GEMINI_HOME || path.join(homedir(), '.gemini')
  const resolved = geminiHome ?? defaultHome
  const checks = [
    antigravitySignedIn(antigravityCliTokenFile(resolved)),
    ...(resolved === defaultHome ? [antigravitySignedIn(antigravityCliAuthStateFile(resolved))] : [])
  ]
  const results = await Promise.all(checks)
  if (results.some(Boolean)) return true
  if (isSystemDefaultGeminiHome(geminiHome)) return Boolean(await readAntigravityKeyringToken())
  return false
}

export async function detectAntigravity(pathEnv?: string, platform: NodeJS.Platform = process.platform, host?: Host): Promise<AgentDetection> {
  const effectivePath = pathEnv !== undefined ? pathEnv : (host?.pathEnv ?? defaultPathEnv())
  const probe = await probeAgyCli(effectivePath, platform)
  if (probe.status === 'ok') {
    return {
      status: 'ok',
      version: probe.version,
      path: probe.file,
      signedIn: await antigravityHomeSignedIn(host ? path.join(host.home, '.gemini') : undefined)
    }
  }
  if (probe.status === 'incompatible') {
    return { status: 'unknown', version: probe.version, path: probe.file, signedIn: null, problem: 'incompatible-version' }
  }
  return { status: 'missing', version: null, path: null, signedIn: null }
}

export async function requireAntigravity(host: Host = thisHost()): Promise<string> {
  const probe = await probeAgyCli(host.pathEnv ?? '', host.platform)
  if (probe.status === 'ok') return probe.file
  if (probe.status === 'incompatible') {
    throw new Rejection('antigravity-incompatible', `agy CLI 版本过低（当前 ${probe.version ?? '未知'}，需要 >= ${AGY_MINIMUM_VERSION}），请运行 agy update 升级`)
  }
  throw new Rejection('antigravity-missing', '未安装 agy CLI（>= 1.5.0），请先安装 agy 或在 设置 → 外部智能体 里安装')
}

export type AntigravityOAuthClient = { clientId: string; clientSecret: string }

const oauthClientCache = new Map<string, readonly AntigravityOAuthClient[]>()

export function extractOAuthClientsFromBinary(rawLatin1: string): readonly AntigravityOAuthClient[] {
  const ids = [...new Set([...rawLatin1.matchAll(/\b\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/g)].map((m) => m[0]))]
  const secrets = [...new Set([...rawLatin1.matchAll(/\bGOCSPX-[A-Za-z0-9_-]{20,40}\b/g)].map((m) => m[0]))]
  const pairs: AntigravityOAuthClient[] = []
  for (const clientId of ids) {
    for (const clientSecret of secrets) {
      pairs.push({ clientId, clientSecret })
    }
  }
  return pairs
}

// Read the public desktop OAuth client embedded in the locally installed agy binary, matching
// readGeminiOAuthClient so no client identifiers or secrets live in Conclave's repository.
export async function readAntigravityOAuthClients(host: Host = thisHost()): Promise<readonly AntigravityOAuthClient[]> {
  const command = await requireAntigravity(host)
  const resolved = await realpath(command).catch(() => command)
  const info = await stat(resolved)
  const key = `${resolved}:${Math.trunc(info.mtimeMs)}:${info.size}`
  const cached = oauthClientCache.get(key)
  if (cached) return cached
  const raw = (await readFile(resolved)).toString('latin1')
  const pairs = extractOAuthClientsFromBinary(raw)
  oauthClientCache.set(key, pairs)
  return pairs
}

export function antigravityInstallation(platform: NodeJS.Platform, _host?: Partial<Host>): AgentCliInstallation | null {
  if (platform === 'darwin' || platform === 'linux') {
    return { agent: 'antigravity', shell: 'bash', command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' }
  }
  if (platform === 'win32') {
    return { agent: 'antigravity', shell: 'powershell', command: 'irm https://antigravity.google/cli/install.ps1 | iex' }
  }
  return null
}
