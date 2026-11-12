import { HISTORY_TOOLS, historyToolName, SHOW_PREVIEW_TOOL, terminalToolName } from '@conclave/protocol'

// env is added to what the agent runs with, for an agent configured through its environment.
export type AgentCommand = { command: string; args: string[]; env?: Record<string, string> }

// An MCP server the agent starts over stdio.
// env is added to what the agent starts the server with.
export type McpServer = { command: string; args: string[]; env?: Record<string, string> }

// One of the user's MCP servers as an agent is given it: started through Conclave's launcher, which
// adds what is secret, or reached at its address where nothing is.
export type AgentMcpServer = { name: string } & ({ type: 'stdio'; command: string; args: string[]; env?: Record<string, string> } | { type: 'http'; url: string })

// Conclave's tools that ask nothing of the user: showing a file the agent wrote, reading or
// stopping a terminal the conversation opened itself, and the user's history (there only where the
// user allows it). Running a command in a terminal is left out.
export function conclaveReadTools(): string[] {
  return [SHOW_PREVIEW_TOOL, terminalToolName('read'), terminalToolName('stop'), ...HISTORY_TOOLS.map(historyToolName)]
}
