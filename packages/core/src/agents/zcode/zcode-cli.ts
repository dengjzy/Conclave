import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentCliInstallation, ChatCatalog } from '@conclave/protocol'
import { probeChatCatalog } from '../../chat-catalog'
import { ZCodeAppServer } from './zcode-app-server'
import { zcodeCommand } from './zcode-command'

// Where ZCode keeps the models the user set up (its v2 provider file) and its sign-in.
export function zcodeHome(home = os.homedir()): string {
  return path.join(home, '.zcode')
}

// It has something to run on: a model provider the user set up, or a Z.ai sign-in.
export async function zcodeSignedIn(home?: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const dir = zcodeHome(home)
  const providers = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() || path.join(dir, 'v2', 'provider_config.json')
  const found = await Promise.all([providers, path.join(dir, 'v2', 'credentials.json')].map((file) => access(file).then(() => true, () => false)))
  return found.some(Boolean)
}

// Its models, from a session it opens and never keeps: one with no message is not saved.
export function zcodeCatalog(cwd: string): Promise<ChatCatalog | null> {
  return probeChatCatalog(new ZCodeAppServer('catalog', { cwd, extraDirs: [], resume: null }, true), zcodeCommand({ providerSessionId: null, resume: false, handoffPath: null, extraProjects: [] }), cwd)
}

// Z.ai ships ZCode as a desktop app, which puts zcode on PATH; on its own the CLI comes only from
// source or from zcode-app-cli, a community package of the same runtime.
export function zcodeInstallation(platform: NodeJS.Platform): AgentCliInstallation | null {
  return { agent: 'zcode', shell: platform === 'win32' ? 'powershell' : 'bash', command: 'npm install -g zcode-app-cli@latest' }
}
