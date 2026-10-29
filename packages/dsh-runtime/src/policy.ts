import { realpathSync } from 'node:fs'
import path from 'node:path'
import { DSH_CONFIG_ENV, DSH_MODE_ENV, DshRuntimeConfig, DshMode } from '@conclave/protocol'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

export function runtimeConfig(): DshRuntimeConfig {
  return DshRuntimeConfig.parse(JSON.parse(process.env[DSH_CONFIG_ENV] ?? '{}'))
}

export function canonical(file: string): string {
  const absolute = path.resolve(file)
  try { return realpathSync(absolute) } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    const parent = path.dirname(absolute)
    if (parent === absolute) throw error
    return path.join(canonical(parent), path.basename(absolute))
  }
}

export function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function modes(config: DshRuntimeConfig): DshMode[] {
  if (config.lock) return [config.lock]
  return ['ask', 'acceptEdits', 'plan', 'readOnly', ...(config.allowBypass && !config.noEdit.length ? ['bypass' as const] : [])]
}

export function operationPolicy(policy: SandboxExecutionPolicy, target: string, config: DshRuntimeConfig, shell = false): SandboxExecutionPolicy {
  const file = canonical(target)
  const mode = DshMode.safeParse(process.env[DSH_MODE_ENV]).data ?? config.mode
  if (config.lock || mode === 'plan' || mode === 'readOnly' || policy.mode === 'read-only') return { ...policy, mode: 'read-only' }
  if (mode === 'acceptEdits' && policy.mode === 'danger-full-access') throw new Error('Conclave: automatic mode cannot widen permissions')
  const protectedRoots = config.noEdit.map(canonical)
  if (protectedRoots.some((root) => inside(file, root))) throw new Error(`Conclave: read-only folder: ${target}`)
  if (policy.mode === 'danger-full-access') {
    if (shell && protectedRoots.length) throw new Error('Conclave: unrestricted commands cannot protect read-only folders')
    return policy
  }
  const roots = [process.cwd(), ...config.workDirs].map(canonical).sort((a, b) => b.length - a.length)
  const root = roots.find((entry) => inside(file, entry))
  if (!root) throw new Error(`Conclave: path is outside this conversation's projects: ${target}`)
  if (shell && protectedRoots.some((entry) => inside(entry, root))) throw new Error('Conclave: this command workspace contains a read-only folder')
  return { ...policy, workspaceRoot: root }
}

const READ_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'ls', 'web_search', 'web_fetch', 'ask_user_question', 'exit_plan_mode', 'get_working_directory', 'set_working_directory', 'job_output', 'job_list'])
const READ_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'rg', 'grep', 'tree', 'file', 'stat', 'which', 'du', 'df'])
const GIT_READS = new Set(['log', 'diff', 'show', 'status', 'blame', 'rev-parse', 'ls-files', 'grep'])

export function toolRefusal(mode: DshMode, name: string, args: unknown, config: DshRuntimeConfig): string | undefined {
  const input = typeof args === 'object' && args !== null ? args : {}
  if ((config.lock || mode === 'plan' || mode === 'readOnly') && 'sandbox_permissions' in input && input.sandbox_permissions !== undefined && input.sandbox_permissions !== 'read-only') return 'Conclave: this stage cannot widen its read-only policy'
  if (mode !== 'plan' && mode !== 'readOnly') return undefined
  if (READ_TOOLS.has(name) || config.readTools.includes(name)) return undefined
  if (name === 'bash' || name === 'pwsh') {
    const command = 'command' in input && typeof input.command === 'string' ? input.command : ''
    if (/[;&|<>`$\n\\]/.test(command)) return 'Conclave: read-only commands cannot chain, redirect, or substitute commands'
    const words = command.trim().split(/\s+/)
    if (words[0] && (READ_COMMANDS.has(words[0]) || (words[0] === 'git' && words[1] && GIT_READS.has(words[1])))) return undefined
  }
  return `Conclave: ${name} is unavailable in ${mode} mode`
}
