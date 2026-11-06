import type { AgentCommand } from './agent-command'
import type { AgentKind, ChatCatalog } from '@conclave/protocol'
import type { ChatDriver } from './chat-driver'
import { z } from 'zod'
import path from 'node:path'

export const NativeArtifact = z.object({ root: z.string(), locator: z.string() })
export type NativeArtifact = z.infer<typeof NativeArtifact>

// A durable locator, without credentials, resolved while its conversation still owns it.
export const NativeSession = z.object({ id: z.string(), root: z.string(), locator: z.string(), cwd: z.string(), artifacts: z.array(NativeArtifact).optional() })
export type NativeSession = z.infer<typeof NativeSession>

export const NativeSessionTarget = z.object({ providerSessionId: z.string(), cwd: z.string(), home: z.string().optional(), artifacts: z.array(NativeArtifact).optional() })
export type NativeSessionTarget = z.infer<typeof NativeSessionTarget>

// Keep the newest stage's artifacts first when resuming across account homes.
export function mergeNativeArtifacts(...groups: Array<readonly NativeArtifact[] | undefined>): NativeArtifact[] | undefined {
  const artifacts = new Map<string, NativeArtifact>()
  for (const group of groups) for (const artifact of group ?? []) {
    const key = JSON.stringify([artifact.root, artifact.locator])
    if (!artifacts.has(key)) artifacts.set(key, artifact)
  }
  return artifacts.size ? [...artifacts.values()] : undefined
}

export function nativeSessionArtifacts(session: NativeSession): NativeArtifact[] | undefined {
  if (session.artifacts) return session.artifacts
  // Older records already captured an exact artifact directory as their locator.
  return path.isAbsolute(session.locator) && path.basename(session.locator) === session.id
    ? [{ root: path.dirname(session.locator), locator: session.locator }] : undefined
}

export function mergeNativeSessions(previous: NativeSession, current: NativeSession): NativeSession {
  if (previous.root !== current.root || previous.id !== current.id) throw new Error('原生会话的存储标识不一致')
  const artifacts = mergeNativeArtifacts(nativeSessionArtifacts(current), nativeSessionArtifacts(previous))
  return artifacts ? { ...previous, artifacts } : previous
}

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
