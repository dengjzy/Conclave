import { fileURLToPath } from 'node:url'
import type { McpServer } from './agent-command'

// How an agent starts Conclave's MCP server (mcp-main.ts). From source it goes through the
// workspace's tsx; packaged, the launcher names the bundled mcp.mjs, run by the Electron binary as
// plain Node. The server's env states the flag outright because an agent's environment lacks it,
// and an env wrapper (/usr/bin/env) is not there on Windows.
export function mcpCommand(...args: string[]): McpServer {
  // An installed app's agent can pass its bundle path into a source checkout it starts.
  const bundled = import.meta.url.endsWith('.ts') ? undefined : process.env.CONCLAVE_MCP_JS
  if (bundled) {
    return { command: process.execPath, args: [bundled, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
  const entry = fileURLToPath(new URL('./mcp-main.ts', import.meta.url))
  return { command: process.execPath, args: ['--import', loader, entry, ...args] }
}
