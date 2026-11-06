import type { AgentCommand } from './agent-command'
import type { AgentKind, ChatCatalog } from '@conclave/protocol'
import type { ChatDriver } from './chat-driver'

// A durable locator, without credentials, resolved while its conversation still owns it.
export type NativeSession = {
  id: string
  root: string
  locator: string
  cwd: string
}

export type NativeSessionTarget = { providerSessionId: string; cwd: string; home?: string }

// Cleanup processes belong to the daemon, just like chat processes.
export interface NativeSessionExecutor {
  catalog?(driver: ChatDriver, command: AgentCommand, cwd: string, onSession?: (id: string, daemonSessionId: string) => Promise<void>): Promise<ChatCatalog | null>
  register?(agent: AgentKind, session: NativeSession, daemonSessionId: string): Promise<void>
  cleanup?(agent: AgentKind, session: NativeSession): Promise<void>
  command(command: AgentCommand, cwd: string): Promise<string>
  acp(command: AgentCommand, cwd: string, method: string, params: Record<string, unknown>): Promise<unknown>
}

export interface NativeSessions {
  // Capture the launch's storage scope before the agent has flushed its first record.
  capture?(target: NativeSessionTarget): NativeSessionTarget
  resolve(target: NativeSessionTarget): Promise<NativeSession | null>
  children(session: NativeSession): Promise<NativeSession[]>
  remove(session: NativeSession, executor: NativeSessionExecutor): Promise<void>
}

export function nativeSessionKey(agent: string, session: NativeSession): string {
  return JSON.stringify([agent, session.root, session.id])
}
