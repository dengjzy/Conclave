import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { AgentCliInstallation, ChatCatalog } from '@conclave/protocol'
import { launchFile } from '@conclave/protocol/node'
import { findOnPath, parseVersion } from '../../environment-check'
import { Rejection } from '../../rejection'
import type { AgentDetection } from '../agent-adapter'

const execute = promisify(execFile)

async function output(command: string, args: string[], cwd?: string, timeout = 10_000): Promise<string> {
  const launch = launchFile(command, args, { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' })
  const result = await execute(launch.file, launch.args, { cwd, env: launch.env, timeout, maxBuffer: 1024 * 1024, windowsHide: true })
  return result.stdout
}

// Conclave speaks to OpenCode 2: its config (agents, permissions, skills) and its ACP differ from 1's.
export function opencodeCompatible(version: string | null): boolean {
  const major = version ? Number(version.split('.')[0]) : NaN
  return major >= 2
}

async function opencodeVersion(command: string): Promise<string | null> {
  return parseVersion(await output(command, ['--version']).catch(() => ''))
}

// It signs in to no account of its own: any provider it has a key for will do, so whether it
// can answer shows only once a model is chosen.
export async function detectOpenCode(pathEnv: string, platform: NodeJS.Platform): Promise<AgentDetection> {
  const path = await findOnPath('opencode', pathEnv, platform)
  if (!path) return { status: 'missing', version: null, path: null, signedIn: null }
  const version = await opencodeVersion(path)
  const compatible = opencodeCompatible(version)
  return {
    status: compatible ? 'ok' : 'unknown', version, path, signedIn: null,
    ...(!compatible ? { problem: version === null ? 'probe-failed' as const : 'incompatible-version' as const } : {})
  }
}

export async function requireOpenCode(): Promise<string> {
  const command = await findOnPath('opencode', process.env.PATH ?? '', process.platform)
  if (!command) throw new Rejection('opencode-cli-missing', '未找到 OpenCode，请安装后重新检测')
  if (!opencodeCompatible(await opencodeVersion(command))) throw new Rejection('opencode-upgrade-required', '请升级 OpenCode，Conclave 需要 2.0 以上版本')
  return command
}

const ModelList = z.looseObject({
  data: z.array(z.looseObject({ providerID: z.string(), id: z.string(), name: z.string(), enabled: z.boolean().catch(false), variants: z.array(z.looseObject({ id: z.string() })).catch([]) }))
})

// Its models as its ACP session names them: provider/model, labelled provider/name, with the
// effort levels a model has and the default its session adds to them. Only the enabled ones, as
// a session offers: `opencode models` would list every model of every provider it knows.
export function parseOpenCodeModels(printed: string): ChatCatalog | null {
  let json: unknown
  try { json = JSON.parse(printed) } catch { return null }
  const enabled = (ModelList.safeParse(json).data?.data ?? []).filter((model) => model.enabled)
  if (!enabled.length) return null
  return {
    models: enabled.map((model) => {
      const variants = model.variants.map((variant) => variant.id)
      return { id: `${model.providerID}/${model.id}`, label: `${model.providerID}/${model.name}`, description: null, efforts: variants.length ? [...new Set([...variants, 'default'])] : [], isDefault: false }
    })
  }
}

// Asked of a private server (--standalone), so it leaves no shared one running.
export async function opencodeCatalog(cwd: string): Promise<ChatCatalog | null> {
  return parseOpenCodeModels(await output(await requireOpenCode(), ['api', '--standalone', 'GET', '/api/model', '--param', `location[directory]=${cwd}`], cwd, 30_000))
}

// Commands published by OpenCode, selected for the core host rather than the client OS.
export function opencodeInstallation(platform: NodeJS.Platform): AgentCliInstallation | null {
  if (platform === 'win32') return { agent: 'opencode', shell: 'powershell', command: 'npm install -g @opencode/cli@latest' }
  if (platform === 'darwin' || platform === 'linux') return { agent: 'opencode', shell: 'bash', command: 'curl -fsSL https://opencode.ai/v2/install | bash' }
  return null
}
