import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { gte, valid } from 'semver'
import type { AgentCliInstallation, ChatCatalog } from '@conclave/protocol'
import { launchFile } from '@conclave/protocol/node'
import { findOnPath } from '../../environment-check'
import { probeChatCatalog } from '../../chat-catalog'
import { Rejection } from '../../rejection'
import type { AgentDetection } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { grokDialect } from './grok-dialect'

const execute = promisify(execFile)

export function grokHome(env = process.env, home = os.homedir()): string {
  return env.GROK_HOME || path.join(home, '.grok')
}

export async function grokSignedIn(env = process.env, home = os.homedir()): Promise<boolean> {
  if (env.GROK_DEPLOYMENT_KEY?.trim() || env.XAI_API_KEY?.trim()) return true
  return access(path.join(grokHome(env, home), 'auth.json')).then(() => true, () => false)
}

export function grokCompatible(version: string | null): boolean {
  return version !== null && valid(version) !== null && gte(version, '1.0.0')
}

async function grokVersion(command: string): Promise<string | null> {
  const launch = launchFile(command, ['--version'], process.env)
  const result = await execute(launch.file, launch.args, { env: launch.env, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }).catch(() => null)
  return /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(result?.stdout ?? '')?.[0] ?? null
}

export async function findGrokCli(pathEnv = process.env.PATH ?? '', platform = process.platform): Promise<string | null> {
  return findOnPath('grok', pathEnv, platform)
}

export async function detectGrok(pathEnv: string, platform: NodeJS.Platform): Promise<AgentDetection> {
  const command = await findGrokCli(pathEnv, platform)
  if (!command) return { status: 'missing', version: null, path: null, signedIn: null }
  const version = await grokVersion(command)
  return {
    status: grokCompatible(version) ? 'ok' : 'unknown',
    version,
    path: command,
    signedIn: await grokSignedIn(),
    ...(!grokCompatible(version) ? { problem: version === null ? ('probe-failed' as const) : ('incompatible-version' as const) } : {})
  }
}

export async function requireGrok(): Promise<string> {
  const command = await findGrokCli()
  if (!command) throw new Rejection('grok-cli-missing', '未找到 Grok CLI，请安装后重新检测')
  if (!grokCompatible(await grokVersion(command))) throw new Rejection('grok-upgrade-required', '请升级到 Grok 1.0.70 以上版本')
  return command
}

export async function grokCatalog(cwd: string): Promise<ChatCatalog | null> {
  return probeChatCatalog(new AcpDriver(grokDialect, 'catalog', { cwd, extraDirs: [], resume: null }), { command: await requireGrok(), args: ['agent', 'stdio'] }, cwd)
}

export function grokInstallation(platform: NodeJS.Platform): AgentCliInstallation {
  return {
    agent: 'grok',
    shell: platform === 'win32' ? 'powershell' : 'bash',
    command: platform === 'win32' ? 'irm https://x.ai/cli/install.ps1 | iex' : 'curl -fsSL https://x.ai/cli/install.sh | bash'
  }
}
