import { fileURLToPath } from 'node:url'
import { launchFile } from '@conclave/protocol/node'
import type { AgentCommand } from '../agent-command'

export type AcpAccountLoginOptions = {
  // Pass `--gemini-dir <stagedHome>` and disable OS keyring so `agy 1.5+` writes isolated file credentials.
  geminiDir?: boolean
  // Authenticate directly in the user's default `~/.gemini` home (for the default account on `agy 1.5+`).
  directDefault?: boolean
}

// Authentication alone, without opening a session or sending a model prompt.
export function acpAccountLogin(
  command: string,
  args: readonly string[],
  credentials: readonly string[],
  options?: AcpAccountLoginOptions
): AgentCommand {
  const launch = launchFile(command, args, process.env)
  return {
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../acp-account-login.mjs', import.meta.url)),
      JSON.stringify({ file: launch.file, args: launch.args, credentials, ...options })
    ],
    env: { ...(launch.env.NODE_PATH ? { NODE_PATH: launch.env.NODE_PATH } : {}), ELECTRON_RUN_AS_NODE: '1' }
  }
}
