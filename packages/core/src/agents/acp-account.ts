import { fileURLToPath } from 'node:url'
import { launchFile } from '@conclave/protocol/node'
import type { AgentCommand } from '../agent-command'

// Authentication alone, without opening a session or sending a model prompt.
export function acpAccountLogin(command: string, args: readonly string[], credentials: readonly string[]): AgentCommand {
  const launch = launchFile(command, args, process.env)
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('../acp-account-login.mjs', import.meta.url)), JSON.stringify({ file: launch.file, args: launch.args, credentials })],
    env: { ...(launch.env.NODE_PATH ? { NODE_PATH: launch.env.NODE_PATH } : {}), ELECTRON_RUN_AS_NODE: '1' }
  }
}
