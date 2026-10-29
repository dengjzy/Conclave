import type { McpServer } from '../../agent-command'
import { Rejection } from '../../rejection'
import { clearMcpReadyFile, mcpReadyFile, mcpReadyWithin, mcpServerReporting } from '../mcp-ready-file'

export function cursorMcpReadyFile(sessionsRoot: string, conversationId: string, stageId: string): string {
  return mcpReadyFile({ sessionsRoot, conversationId, stageId }, 'cursor')
}

export function cursorMcpServer(server: McpServer, readyFile: string, planOnly: boolean): McpServer {
  return mcpServerReporting(server, readyFile, planOnly)
}

export const prepareCursorMcp = clearMcpReadyFile

// Cursor can swallow an MCP launch error and still open the ACP session successfully.
export async function waitForCursorMcp(file: string, waitMs = 5000): Promise<void> {
  if (!await mcpReadyWithin(file, waitMs)) throw new Rejection('cursor-mcp-unavailable', 'Cursor 未能加载 Conclave MCP，请检查 CLI 版本、服务器权限或企业策略后重试')
}
