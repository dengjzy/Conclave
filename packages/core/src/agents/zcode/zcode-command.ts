import type { AgentCommand } from '../../agent-command'
import type { AgentLaunch } from '../agent-adapter'

// ZCode's app-server over stdio: everything else, the session's folders and MCP servers among it,
// goes over its protocol, so the command line is the same for every stage.
export function zcodeCommand(_launch: AgentLaunch): AgentCommand {
  return { command: 'zcode', args: ['app-server', '--stdio'] }
}
