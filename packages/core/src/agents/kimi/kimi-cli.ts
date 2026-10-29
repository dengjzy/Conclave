import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentCliInstallation, ChatCatalog } from '@conclave/protocol'
import { launchFile } from '@conclave/protocol/node'
import { findOnPath, parseVersion } from '../../environment-check'
import { probeChatCatalog } from '../../chat-catalog'
import { Rejection } from '../../rejection'
import type { AgentDetection } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { kimiDialect } from './kimi-dialect'

const execute = promisify(execFile)

// The Node.js ACP implementation, verified against the official 2.3.2 runtime.
export function kimiCompatible(version: string | null): boolean {
  if (!version) return false
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number)
  return major > 2 || (major === 2 && (minor > 3 || (minor === 3 && patch >= 2)))
}

async function kimiVersion(command: string): Promise<string | null> {
  const launch = launchFile(command, ['--version'], process.env)
  const result = await execute(launch.file, launch.args, { env: launch.env, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }).catch(() => null)
  return parseVersion(result?.stdout ?? '')
}

export async function detectKimi(pathEnv: string, platform: NodeJS.Platform): Promise<AgentDetection> {
  const path = await findOnPath('kimi', pathEnv, platform)
  if (!path) return { status: 'missing', version: null, path: null, signedIn: null }
  const version = await kimiVersion(path)
  return {
    status: kimiCompatible(version) ? 'ok' : 'unknown', version, path, signedIn: null,
    ...(!kimiCompatible(version) ? { problem: version === null ? 'probe-failed' as const : 'incompatible-version' as const } : {})
  }
}

export async function requireKimi(): Promise<string> {
  const command = await findOnPath('kimi', process.env.PATH ?? '', process.platform)
  if (!command) throw new Rejection('kimi-cli-missing', '未找到 Kimi Code，请安装后重新检测')
  if (!kimiCompatible(await kimiVersion(command))) throw new Rejection('kimi-upgrade-required', '请升级到 Node.js 版 Kimi Code CLI 2.3.2 以上版本')
  return command
}

// Session creation lists configured models without sending anything to the model or signing in.
export async function kimiCatalog(cwd: string): Promise<ChatCatalog | null> {
  return probeChatCatalog(new AcpDriver(kimiDialect, 'catalog', { cwd, extraDirs: [], resume: null }), { command: await requireKimi(), args: ['acp'] }, cwd)
}

export function kimiInstallation(platform: NodeJS.Platform): AgentCliInstallation {
  return { agent: 'kimi', shell: platform === 'win32' ? 'powershell' : 'bash', command: 'npm install -g @moonshot-ai/kimi-code@latest' }
}
