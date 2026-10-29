import { RESERVED_MCP_SERVER_NAME } from '@conclave/protocol'
import type { AcpDialect } from '../acp/acp-dialect'
import { OPENCODE_AUTO_AGENT, OPENCODE_BYPASS_AGENT, OPENCODE_READ_ONLY_AGENT } from './opencode-config'

const MCP_PREFIX = `${RESERVED_MCP_SERVER_NAME}_`
// Its tools whose ACP kind already names them (execute, edit, read, search, fetch).
const BUILT_IN_BY_KIND: ReadonlySet<string> = new Set(['shell', 'bash', 'edit', 'write', 'patch', 'read', 'grep', 'glob', 'webfetch'])

// OpenCode's ACP: its modes are its primary agents, and it names each tool call beside its kind.
// Models and their effort levels come in the session config, so it needs no listing of its own.
export const opencodeDialect: AcpDialect = {
  name: 'OpenCode',
  idPrefix: 'opencode',
  modes: { ask: 'build', acceptEdits: OPENCODE_AUTO_AGENT, plan: 'plan', readOnly: OPENCODE_READ_ONLY_AGENT, bypass: OPENCODE_BYPASS_AGENT },
  authMethod: 'opencode-login',
  ownMcpOnCommand: true,
  // It names an MCP tool <server>_<tool>; Conclave knows its own as conclave.<tool>, as Codex and
  // Cursor name them. Its built-in tools are left to their kind; any other keeps its own name,
  // which says more than the kind `other`.
  toolName: (_rawInput, name) => {
    if (!name || BUILT_IN_BY_KIND.has(name)) return null
    return name.startsWith(MCP_PREFIX) ? `${RESERVED_MCP_SERVER_NAME}.${name.slice(MCP_PREFIX.length)}` : name
  }
}
