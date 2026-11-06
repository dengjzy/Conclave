import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NATIVE_SESSION_LOG_ENV, OwnedNativeSession, type AgentKind } from '@conclave/protocol'
import { z } from 'zod'
import { ChatLog } from './chat-log'

export { NATIVE_SESSION_LOG_ENV }

export function ownedSessionLog(sessionsRoot: string, conversationId: string): string {
  return path.join(sessionsRoot, conversationId, 'owned-sessions.jsonl')
}

export async function readOwnedNativeSessions(sessionsRoot: string, conversationId: string): Promise<OwnedNativeSession[]> {
  const file = ownedSessionLog(sessionsRoot, conversationId)
  const text = await readFile(file, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  })
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => OwnedNativeSession.parse(JSON.parse(line)))
}

const Spawned = z.looseObject({ method: z.literal('session/update'), params: z.looseObject({
  update: z.looseObject({ sessionUpdate: z.literal('subagent_spawned'), subagentSessionId: z.string().min(1) })
}) })
const ChildMetadata = z.looseObject({ method: z.literal('session/update'), params: z.looseObject({
  update: z.looseObject({ _meta: z.looseObject({ 'opencode/child-session': z.looseObject({ id: z.string().min(1), parentID: z.string().min(1) }) }) })
}) })

// Explicit protocol parentage survives a restart even when the CLI has no child index.
export function readStageOwnedSessions(sessionsRoot: string, conversationId: string, stageId: string, agent: AgentKind, cwd: string, home?: string): OwnedNativeSession[] {
  const found = new Set<string>()
  for (const record of ChatLog.of(sessionsRoot, conversationId, stageId).read().records) {
    if (record.dir !== 'in') continue
    const frame = Spawned.safeParse(record.frame)
    if (frame.success) found.add(frame.data.params.update.subagentSessionId)
    const child = ChildMetadata.safeParse(record.frame)
    if (child.success) found.add(child.data.params.update._meta['opencode/child-session'].id)
  }
  return [...found].map((providerSessionId) => ({ agent, providerSessionId, cwd, ...(home ? { home } : {}) }))
}
