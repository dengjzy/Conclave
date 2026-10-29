import { RESERVED_MCP_SERVER_NAME } from '@conclave/protocol'
import type { AgentCommand, AgentMcpServer } from '../../agent-command'
import { startNote } from '../../agent-prompt'
import type { AgentLaunch } from '../agent-adapter'
import { codexProviderLaunch } from './codex-provider'

// The ChatGPT app's own browser, which its unified-computer-use plugin gives every Codex as the
// cua_repl MCP server: beside Conclave's browser tools Codex reached for it first, and its policy,
// kept in that app, refuses a Codex that Conclave runs. A whole entry, disabled, overrides the
// plugin's; enabled=false alone is an incomplete server that Codex refuses to start with, and a
// whole one is harmless where the plugin is not installed.
const HIDDEN_CODEX_BROWSERS: readonly string[] = ['-c', 'mcp_servers.cua_repl={command="/usr/bin/true",enabled=false}']

const tomlTable = (values: Record<string, string>) => `{${Object.entries(values).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`

// A whole entry, as an inline table: it replaces one of the same name in the user's config.toml
// rather than merging with it. JSON arrays of strings are TOML arrays too.
function codexServer(server: AgentMcpServer): string {
  return server.type === 'stdio'
    ? `{command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)}${server.env ? `,env=${tomlTable(server.env)}` : ''}}`
    : `{url=${JSON.stringify(server.url)}}`
}

// app-server takes the thread, sandbox and extra roots over the protocol instead; Conclave's MCP
// server goes in as a config override, as does the start note (the user's vault itself is a
// writable root of each turn, see CodexAppServer). A JSON string is a TOML basic string. A skills
// bundle (AgentLaunch.skills) is not given: Codex reads skills from fixed folders only; the places
// to try are skills.config in its config and the cwds of skills/list (CodexAppServer).
export function codexCommand({ mcp, userMcp = [], knowledgeBase, instructions, todos = true, provider, preferred, account }: AgentLaunch): AgentCommand {
  const note = startNote({ knowledgeBase, instructions, todos: Boolean(mcp) && todos })
  const onProvider = provider ? codexProviderLaunch(provider, preferred?.model) : null
  // A provider is reached with a key, not an account: it takes the place of one.
  const env = onProvider ? onProvider.env : account?.env
  return { command: 'codex', ...(env ? { env } : {}), args: [
    'app-server',
    ...(mcp ? ['-c', `mcp_servers.${RESERVED_MCP_SERVER_NAME}.command=${JSON.stringify(mcp.command)}`, '-c', `mcp_servers.${RESERVED_MCP_SERVER_NAME}.args=${JSON.stringify(mcp.args)}`, ...(mcp.env ? ['-c', `mcp_servers.${RESERVED_MCP_SERVER_NAME}.env=${tomlTable(mcp.env)}`] : []), ...HIDDEN_CODEX_BROWSERS] : []),
    ...userMcp.flatMap((server) => ['-c', `mcp_servers.${server.name}=${codexServer(server)}`]),
    ...(note ? ['-c', `developer_instructions=${JSON.stringify(note)}`] : []),
    ...(onProvider?.args ?? [])
  ] }
}
