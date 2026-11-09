import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { gte, valid } from 'semver'
import { z } from 'zod'
import type { AgentCliInstallation, ChatCatalog } from '@conclave/protocol'
import { launchFile } from '@conclave/protocol/node'
import { findOnPath } from '../../environment-check'
import type { NativeSessionExecutor } from '../../native-session'
import { geminiSessions } from './gemini-sessions'
import { Rejection } from '../../rejection'
import { parseJson } from '../../usage-source'
import type { AgentDetection } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { geminiDialect } from './gemini-dialect'
import { geminiHome } from './gemini-home'
export { geminiHome } from './gemini-home'

const execute = promisify(execFile)
const Settings = z.looseObject({ security: z.looseObject({ auth: z.looseObject({ selectedType: z.string().optional() }).optional() }).optional() })

export async function geminiAuthType(env = process.env, home = os.homedir()): Promise<string | null> {
  const settings = Settings.safeParse(parseJson(await readFile(path.join(geminiHome(env, home), 'settings.json'), 'utf8').catch(() => null))).data
  return settings?.security?.auth?.selectedType ?? null
}

export async function geminiSignedIn(home?: string): Promise<boolean> {
  const env = home ? { ...process.env, GEMINI_CLI_HOME: home } : process.env
  const auth = await geminiAuthType(env)
  if (auth === 'oauth-personal') return access(path.join(geminiHome(env), 'oauth_creds.json')).then(() => true, () => false)
  // Vertex can use ADC outside the CLI folder; only the SDK can validate those credentials.
  if (auth === 'vertex-ai') return true
  return Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim())
}

export function geminiCompatible(version: string | null): boolean {
  return version !== null && valid(version) !== null && gte(version, '0.66.0')
}

async function geminiVersion(command: string): Promise<string | null> {
  const launch = launchFile(command, ['--version'], process.env)
  const result = await execute(launch.file, launch.args, { env: launch.env, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }).catch(() => null)
  return /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/.exec(result?.stdout ?? '')?.[0] ?? null
}

export async function detectGemini(pathEnv: string, platform: NodeJS.Platform): Promise<AgentDetection> {
  const command = await findOnPath('gemini', pathEnv, platform)
  if (!command) return { status: 'missing', version: null, path: null, signedIn: null }
  const version = await geminiVersion(command)
  return { status: geminiCompatible(version) ? 'ok' : 'unknown', version, path: command, signedIn: await geminiSignedIn(),
    ...(!geminiCompatible(version) ? { problem: version === null ? 'probe-failed' as const : 'incompatible-version' as const } : {}) }
}

export async function requireGemini(): Promise<string> {
  const command = await findOnPath('gemini', process.env.PATH ?? '', process.platform)
  if (!command) throw new Rejection('gemini-cli-missing', '未找到 Gemini CLI，请安装后重新检测')
  if (!geminiCompatible(await geminiVersion(command))) throw new Rejection('gemini-upgrade-required', '请升级到 Gemini CLI 0.66.0 以上版本')
  return command
}

export async function geminiCatalog(cwd: string, executor?: NativeSessionExecutor, env?: Record<string, string>): Promise<ChatCatalog | null> {
  if (!executor?.catalog || !executor.cleanup || !executor.register || !await geminiSignedIn(env?.GEMINI_CLI_HOME)) return null
  const command = await requireGemini()
  const driver = new AcpDriver(geminiDialect, 'catalog', { cwd, extraDirs: [], resume: null })
  try {
    return await executor.catalog(driver, { command, args: ['--acp', '--skip-trust'], ...(env ? { env } : {}) }, cwd, async (id, daemonSessionId) => {
      const session = await geminiSessions().resolve({ providerSessionId: id, cwd })
      if (session) await executor.register?.('gemini', session, daemonSessionId)
    })
  } finally {
    const id = driver.providerSessionId()
    if (id) {
      const session = await geminiSessions().resolve({ providerSessionId: id, cwd })
      if (session) await executor.cleanup('gemini', session)
    }
  }
}

export function geminiInstallation(platform: NodeJS.Platform): AgentCliInstallation {
  return { agent: 'gemini', shell: platform === 'win32' ? 'powershell' : 'bash', command: 'npm install -g @google/gemini-cli@latest' }
}
