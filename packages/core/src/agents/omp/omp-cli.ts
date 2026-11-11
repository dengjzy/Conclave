import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { gte, valid } from 'semver'
import type { AgentCliInstallation, ChatCatalog } from '@conclave/protocol'
import { launchFile } from '@conclave/protocol/node'
import { findOnPath, parseVersion } from '../../environment-check'
import { Rejection } from '../../rejection'
import type { AgentDetection } from '../agent-adapter'

const execute = promisify(execFile)

// The release that carries the ACP session controls, model configuration and permission requests
// this adapter runs on.
export const OMP_MIN_VERSION = '18.18.8'

export function ompCompatible(version: string | null): boolean {
  return version !== null && valid(version) !== null && gte(version, OMP_MIN_VERSION)
}

async function ompVersion(command: string): Promise<string | null> {
  const launch = launchFile(command, ['--version'], process.env)
  const result = await execute(launch.file, launch.args, { env: launch.env, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }).catch(() => null)
  return result ? parseVersion(`${result.stdout}\n${result.stderr}`) : null
}

export async function findOmp(pathEnv = process.env.PATH ?? '', platform = process.platform): Promise<string | null> {
  return findOnPath('omp', pathEnv, platform)
}

export async function detectOmp(pathEnv: string, platform: NodeJS.Platform): Promise<AgentDetection> {
  const command = await findOmp(pathEnv, platform)
  if (!command) return { status: 'missing', version: null, path: null, signedIn: null }
  const version = await ompVersion(command)
  const compatible = ompCompatible(version)
  return {
    status: compatible ? 'ok' : 'unknown',
    version,
    path: command,
    // Credentials live in omp's own provider store or the environment; this check does not read them.
    signedIn: null,
    ...(!compatible ? { problem: version === null ? ('probe-failed' as const) : ('incompatible-version' as const) } : {})
  }
}

export async function requireOmp(): Promise<string> {
  const command = await findOmp()
  if (!command) throw new Rejection('omp-cli-missing', '未找到 omp，请安装后重新检测')
  if (!ompCompatible(await ompVersion(command))) throw new Rejection('omp-upgrade-required', `请升级 omp，Conclave 需要 ${OMP_MIN_VERSION} 以上版本`)
  return command
}

const Catalog = z.object({
  models: z.array(z.looseObject({
    kind: z.string().optional(),
    id: z.string(),
    selector: z.string(),
    name: z.string(),
    reasoning: z.boolean().nullish(),
    thinking: z.array(z.string()).catch([])
  }))
})
const Roles = z.record(z.string(), z.unknown())

async function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  const launch = launchFile(command, [...args], process.env)
  const result = await execute(launch.file, launch.args, { cwd, env: launch.env, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  return result.stdout
}

// Its models as the CLI itself lists them, independent of a chat: only those its configured
// credentials can reach, with the thinking levels each takes. The default role names the one a
// new session starts on.
export async function ompCatalog(cwd: string): Promise<ChatCatalog | null> {
  const command = await requireOmp()
  const [printed, roles] = await Promise.all([
    run(command, ['models', '--json'], cwd).catch(() => null),
    run(command, ['config', 'get', 'modelRoles'], cwd).catch(() => null)
  ])
  if (!printed) return null
  let catalog: z.infer<typeof Catalog>
  try {
    catalog = Catalog.parse(JSON.parse(printed))
  } catch {
    return null
  }
  let named: unknown = null
  if (roles) {
    try {
      named = Roles.parse(JSON.parse(roles)).default
    } catch { /* No default role is still a catalog. */ }
  }
  const defaultId = typeof named === 'string' ? named.replace(/:\w+$/, '') : null
  const models = catalog.models
    .filter((model) => (model.kind ?? 'chat') === 'chat')
    .map((model) => ({
      id: model.selector,
      label: model.name,
      description: null,
      efforts: model.reasoning === false ? [] : [...model.thinking],
      isDefault: model.selector === defaultId || model.id === defaultId
    }))
  return models.length ? { models } : null
}

export function ompInstallation(platform: NodeJS.Platform): AgentCliInstallation {
  return {
    agent: 'omp',
    shell: platform === 'win32' ? 'powershell' : 'bash',
    command: platform === 'win32' ? 'irm https://omp.sh/install.ps1 | iex' : 'curl -fsSL https://omp.sh/install | sh'
  }
}
