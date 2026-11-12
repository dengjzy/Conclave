import { RESERVED_MCP_SERVER_NAME } from '@conclave/protocol'
import type { AgentCommand, AgentMcpServer } from '../../agent-command'
import { startNote } from '../../agent-prompt'
import type { AgentLaunch } from '../agent-adapter'
import { codexProviderLaunch } from './codex-provider'

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
export function codexCommand({ mcp, userMcp = [], knowledgeBase, instructions, provider, preferred, account }: AgentLaunch): AgentCommand {
  const note = startNote({ knowledgeBase, instructions })
  const onProvider = provider ? codexProviderLaunch(provider, preferred?.model) : null
  // A provider is reached with a key, not an account: it takes the place of one.
  const env = onProvider ? onProvider.env : account?.env
  return { command: 'codex', ...(env ? { env } : {}), args: [
    'app-server',
    ...(mcp ? ['-c', `mcp_servers.${RESERVED_MCP_SERVER_NAME}.command=${JSON.stringify(mcp.command)}`, '-c', `mcp_servers.${RESERVED_MCP_SERVER_NAME}.args=${JSON.stringify(mcp.args)}`, ...(mcp.env ? ['-c', `mcp_servers.${RESERVED_MCP_SERVER_NAME}.env=${tomlTable(mcp.env)}`] : [])] : []),
    ...userMcp.flatMap((server) => ['-c', `mcp_servers.${server.name}=${codexServer(server)}`]),
    ...(note ? ['-c', `developer_instructions=${JSON.stringify(note)}`] : []),
    ...(onProvider?.args ?? [])
  ] }
}
