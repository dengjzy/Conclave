import { access, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '../agent-command'
import type { AgentStage } from './agent-adapter'

// For an agent that may start without Conclave's MCP server and say nothing of it: the server
// writes this file once the agent has it, and the stage waits for the file before its first
// message. One per stage, under the conversation's own folder.
export function mcpReadyFile(stage: Pick<AgentStage, 'sessionsRoot' | 'conversationId' | 'stageId'>, agent: string): string {
  return path.join(stage.sessionsRoot, stage.conversationId, `${agent}-mcp`, `${stage.stageId}.json`)
}

// The server, told where to report, and kept to what reads in a stage that changes nothing.
// onList: it reports once the agent has listed its tools, not once it has connected.
export function mcpServerReporting(server: McpServer, file: string, planOnly: boolean, onList = false): McpServer {
  return { ...server, args: [...server.args, '--ready-file', file, ...(onList ? ['--ready-on-list'] : []), ...(planOnly ? ['--plan-only'] : [])] }
}

// A file left by an earlier start of the stage would read as this one's.
export async function clearMcpReadyFile(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await rm(file, { force: true })
}

export async function mcpReadyWithin(file: string, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    if (await access(file).then(() => true, () => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}
