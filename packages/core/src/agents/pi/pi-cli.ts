import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import semver from 'semver'
import type { AgentCliInstallation, ChatCatalog } from '@conclave/protocol'
import { launchFile } from '@conclave/protocol/node'
import { probeChatCatalog } from '../../chat-catalog'
import { findOnPath, parseVersion } from '../../environment-check'
import { Rejection } from '../../rejection'
import type { AgentDetection } from '../agent-adapter'
import { PI_ENV } from './pi-command'
import { PiRpc } from './pi-rpc'

const execute = promisify(execFile)

// Conclave's extension adds its MCP servers with registerMcpServer, which Pi has from 0.99.
export const PI_MIN_VERSION = '0.99.0'

export function piCompatible(version: string | null): boolean {
  return version !== null && semver.valid(version) !== null && semver.gte(version, PI_MIN_VERSION)
}

async function piVersion(command: string): Promise<string | null> {
  const launch = launchFile(command, ['--version'], { ...process.env, ...PI_ENV, PI_OFFLINE: '1' })
  const result = await execute(launch.file, launch.args, { env: launch.env, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }).catch(() => null)
  return result ? parseVersion(`${result.stdout}\n${result.stderr}`) : null
}

// It signs in to no account of its own: any provider it has a key for will do, which shows only
// once it lists its models.
export async function detectPi(pathEnv: string, platform: NodeJS.Platform): Promise<AgentDetection> {
  const path = await findOnPath('pi', pathEnv, platform)
  if (!path) return { status: 'missing', version: null, path: null, signedIn: null }
  const version = await piVersion(path)
  const compatible = piCompatible(version)
  return {
    status: compatible ? 'ok' : 'unknown', version, path, signedIn: null,
    ...(!compatible ? { problem: version === null ? 'probe-failed' as const : 'incompatible-version' as const } : {})
  }
}

export async function requirePi(): Promise<string> {
  const command = await findOnPath('pi', process.env.PATH ?? '', process.platform)
  if (!command) throw new Rejection('pi-cli-missing', '未找到 Pi，请安装后重新检测')
  if (!piCompatible(await piVersion(command))) throw new Rejection('pi-upgrade-required', `请升级 Pi，Conclave 需要 ${PI_MIN_VERSION} 以上版本`)
  return command
}

// Its models as a session lists them, from a process that keeps no session file.
export async function piCatalog(cwd: string): Promise<ChatCatalog | null> {
  const command = await requirePi()
  return probeChatCatalog(new PiRpc('catalog', { cwd, extraDirs: [], resume: null }, true), { command, args: ['--mode', 'rpc', '--no-session'], env: PI_ENV }, cwd)
}

export function piInstallation(platform: NodeJS.Platform): AgentCliInstallation | null {
  return { agent: 'pi', shell: platform === 'win32' ? 'powershell' : 'bash', command: 'npm install -g @earendil-works/pi-coding-agent' }
}
