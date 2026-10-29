import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AGENT_KINDS, type AgentKind, type Conversation, type ExternalSession, type ExternalSessionRef } from '@conclave/protocol'
import type { Transcript, TranscriptSource, TranscriptSummary } from './agent-transcripts'
import { adapterOf } from './agents'
import type { ConversationService } from './conversation-service'
import type { ConversationStore, SessionImport } from './conversation-store'
import { Rejection } from './rejection'

const MAX_LISTED = 500
// ZCode names its sessions sess_<uuid>.
const SESSION_ID = /^(?:sess_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A file written just as a stage of Conclave's own ended still counts as that stage's.
const SETTLE_MS = 2_000

export type TranscriptOrigin = { agent: AgentKind; transcripts: TranscriptSource }
type Found = TranscriptSummary & { agent: AgentKind }

export function transcriptOrigins(): TranscriptOrigin[] {
  return AGENT_KINDS.flatMap((agent) => {
    const { transcripts } = adapterOf(agent)
    return transcripts ? [{ agent, transcripts }] : []
  })
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function isDirectory(dir: string): Promise<boolean> {
  return (await stat(dir).catch(() => null))?.isDirectory() ?? false
}

// The sessions Claude Code, Codex and ZCode ran outside Conclave, and their import as conversations that
// go on in the agent's own session. One imported again brings in only what was added since.
export class SessionImports {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: ConversationStore,
    private readonly conversations: Pick<ConversationService, 'create' | 'get' | 'importStage'>,
    // Conclave's own folders: what ran there is Conclave's, even from another of its homes.
    private readonly conclaveHome: string,
    private readonly origins: readonly TranscriptOrigin[] = transcriptOrigins(),
    private readonly scratch: readonly string[] = [os.tmpdir(), '/tmp', '/private/tmp']
  ) {}

  async list(): Promise<ExternalSession[]> {
    const found = (await this.scan()).slice(0, MAX_LISTED)
    const imports = this.imports()
    return Promise.all(found.map(async (summary): Promise<ExternalSession> => {
      const record = imports.get(`${summary.agent}:${summary.sessionId}`)
      return {
        agent: summary.agent,
        sessionId: summary.sessionId,
        cwd: summary.cwd,
        title: summary.title,
        firstPrompt: summary.firstPrompt,
        startedAt: summary.startedAt,
        updatedAt: summary.modifiedAt,
        status: !record ? 'new' : this.updated(summary, record) ? 'updated' : 'imported',
        conversationId: record?.conversationId ?? null,
        problem: (await isDirectory(summary.cwd)) ? null : 'missing-cwd'
      }
    }))
  }

  // One at a time: two imports of the same session must not both make a conversation.
  import(refs: readonly ExternalSessionRef[]): Promise<Conversation[]> {
    const run = this.queue.catch(() => {}).then(() => this.importNow(refs))
    this.queue = run
    return run
  }

  // Deletes an external session physically from the agent's underlying local storage,
  // making it disappear from both Conclave and the native agent CLI.
  async deleteSessionSource(agent: AgentKind, sessionId: string): Promise<void> {
    const found = await this.scan()
    const summary = found.find((each) => each.agent === agent && each.sessionId === sessionId)
    const origin = this.origins.find((each) => each.agent === agent)
    if (summary && origin?.transcripts.delete) {
      await origin.transcripts.delete(summary.file)
    }
    this.store.removeSessionImport(agent, sessionId)
  }

  // When a conversation is deleted in Conclave, if it originated from an imported
  // external agent session, clean up the underlying native session file too.
  async purgeImported(conversationId: string): Promise<void> {
    const imports = this.store.sessionImports().filter((record) => record.conversationId === conversationId)
    for (const record of imports) {
      await this.deleteSessionSource(record.agent, record.sessionId).catch((err) => {
        console.warn(`[conclave-core] deleting external session for ${record.agent}:${record.sessionId} failed:`, err)
      })
    }
  }

  private async importNow(refs: readonly ExternalSessionRef[]): Promise<Conversation[]> {
    const found = await this.scan()
    const done: Conversation[] = []
    for (const ref of refs) {
      if (!SESSION_ID.test(ref.sessionId)) throw new Rejection('invalid-params', 'not a session id')
      // The file comes from the scan, never from the client.
      const summary = found.find((each) => each.agent === ref.agent && each.sessionId === ref.sessionId)
      const origin = this.origins.find((each) => each.agent === ref.agent)
      if (!summary || !origin) throw new Rejection('session-not-found', '找不到这个会话')
      if (!(await isDirectory(summary.cwd))) throw new Rejection('invalid-workspace', `会话所在的目录已不存在：${summary.cwd}`)
      const record = this.imports().get(`${summary.agent}:${summary.sessionId}`)
      const transcript = await origin.transcripts.read(summary.file)
      const through = transcript.entries.reduce((max, entry) => Math.max(max, entry.at), record?.importedThrough ?? 0)
      let conversation: Conversation
      if (!record) {
        const created = await this.conversations.create(summary.agent, [summary.cwd], undefined, { deferStart: true })
        conversation = this.conversations.importStage(created.id, summary.agent, summary.sessionId, transcript, { text: summary.title, locked: summary.named })
      } else {
        const added = this.since(transcript, record)
        conversation = added.entries.length
          ? this.conversations.importStage(record.conversationId, summary.agent, summary.sessionId, added)
          : this.conversations.get(record.conversationId)
      }
      this.store.recordSessionImport({ agent: summary.agent, sessionId: summary.sessionId, conversationId: conversation.id, importedThrough: through, sourceModifiedAt: summary.modifiedAt })
      done.push(conversation)
    }
    return done
  }

  // What the session added after it was imported, other than what Conclave itself ran in it: a
  // resumed session goes on in the same file.
  private since(transcript: Transcript, record: SessionImport): Transcript {
    const fresh = (at: number) => at > record.importedThrough && !this.ranHere(record.conversationId, at)
    return { entries: transcript.entries.filter((entry) => fresh(entry.at)), messages: transcript.messages.filter((message) => fresh(message.at)) }
  }

  // The file changed since it was imported, and not while a stage here had the session.
  private updated(summary: Found, record: SessionImport): boolean {
    return summary.modifiedAt > record.sourceModifiedAt && !this.ranHere(record.conversationId, summary.modifiedAt)
  }

  private ranHere(conversationId: string, at: number): boolean {
    return this.store.stages(conversationId).some((stage) => at >= stage.startedAt && at <= (stage.endedAt ?? Infinity) + SETTLE_MS)
  }

  private imports(): Map<string, SessionImport> {
    return new Map(this.store.sessionImports().map((record) => [`${record.agent}:${record.sessionId}`, record]))
  }

  // Newest first. A session a stage here ran is Conclave's own unless it came in by import; so is one
  // run in Conclave's folders, and one in a scratch folder is nobody's to go on with.
  private async scan(): Promise<Found[]> {
    const scanned = await Promise.all(this.origins.map(async ({ agent, transcripts }) =>
      (await transcripts.scan().catch((error: unknown) => {
        console.error(`[conclave-core] reading ${agent} sessions failed:`, error)
        return []
      })).map((summary): Found => ({ ...summary, agent }))))
    const owned = this.store.providerSessions()
    const imported = this.imports()
    return scanned.flat()
      .filter((summary) => {
        const key = `${summary.agent}:${summary.sessionId}`
        if (imported.has(key)) return true
        return !owned.has(key) && !inside(this.conclaveHome, summary.cwd) && !this.scratch.some((dir) => inside(dir, summary.cwd))
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
  }
}
