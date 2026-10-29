import { stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { CONTEXT_COMPACTED } from '@conclave/protocol'
import { clip, type ChatItemBody } from '../../chat-items'
import { titleOf, type Transcript, type TranscriptEntry, type TranscriptMessage, type TranscriptSource, type TranscriptSummary } from '../../agent-transcripts'
import { describeClaudeTool, inputDiffs, inputText } from '../claude/claude-stream'

// ZCode keeps every session in one SQLite database, laid out as OpenCode's: a session row, its
// messages, and each message's parts (text, reasoning, a tool call with its state), as JSON.
export function zcodeSessionDb(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.ZCODE_SESSION_DB_PATH?.trim() || path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
}

const SessionRow = z.object({ id: z.string(), directory: z.string(), title: z.string(), title_source: z.string().nullable().catch(null), time_created: z.number(), time_updated: z.number(), prompt: z.string().nullable() })
const Semantics = z.looseObject({ origin: z.string().optional(), uiVisibility: z.string().optional() })
const MessageData = z.looseObject({
  role: z.string(),
  semantics: Semantics.optional(),
  anchor: z.looseObject({ turnId: z.string().optional() }).optional(),
  error: z.unknown().optional()
})
const PartData = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  tool: z.string().optional(),
  callID: z.string().optional(),
  state: z.looseObject({ status: z.string(), input: z.record(z.string(), z.unknown()).catch({}).optional(), output: z.unknown().optional(), error: z.unknown().optional() }).optional()
})
const Row = z.object({ message: z.string(), at: z.number(), data: z.string(), part: z.string().nullable(), partData: z.string().nullable() })

// Tools whose calls the chat shows elsewhere, or not at all.
const HIDDEN = new Set(['AskUserQuestion', 'ExitPlanMode', 'TodoWrite', 'TodoRead', 'ToolSearch'])

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// A message the user typed in a session: not ZCode's reminders, nor the results it reports back.
function typed(data: z.infer<typeof MessageData>): boolean {
  return data.role === 'user' && data.semantics?.origin === 'real_user' && data.semantics.uiVisibility !== 'hidden'
}

function open(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true })
}

function scanSessions(file: string): TranscriptSummary[] {
  const db = open(file)
  try {
    // Sessions the user ran: not a subagent's, a workflow's, or one deleted; each with the first
    // thing typed in it.
    const rows = db.prepare(`
      SELECT s.id, s.directory, s.title, s.title_source, s.time_created, s.time_updated, (
        SELECT p.data FROM message m JOIN part p ON p.message_id = m.id
        WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user' AND json_extract(m.data, '$.semantics.origin') = 'real_user' AND json_extract(p.data, '$.type') = 'text'
        ORDER BY m.time_created, m.sequence, p.sequence LIMIT 1
      ) AS prompt
      FROM session s
      WHERE s.parent_id IS NULL AND s.task_type = 'interactive' AND s.time_deleted IS NULL
      ORDER BY s.time_updated DESC`).all()
    return rows.flatMap((raw) => {
      const row = SessionRow.safeParse(raw)
      if (!row.success) return []
      const prompt = row.data.prompt ? PartData.safeParse(json(row.data.prompt)).data?.text?.trim() : undefined
      if (!prompt) return []
      return [{
        sessionId: row.data.id,
        cwd: row.data.directory,
        title: row.data.title.trim() || titleOf(prompt),
        named: row.data.title_source === 'custom',
        firstPrompt: titleOf(prompt, 200),
        startedAt: row.data.time_created,
        modifiedAt: row.data.time_updated,
        file: `${file}#${row.data.id}`
      }]
    })
  } finally {
    db.close()
  }
}

function toolItem(id: string, part: z.infer<typeof PartData>): ChatItemBody | null {
  const name = part.tool
  if (!name || HIDDEN.has(name)) return null
  const input = part.state?.input ?? {}
  const settled = part.state?.status
  const status = settled === 'completed' ? 'done' : settled === 'error' ? 'failed' : 'interrupted'
  const output = typeof part.state?.output === 'string' ? part.state.output : typeof part.state?.error === 'string' ? part.state.error : null
  return {
    id,
    kind: 'tool',
    name,
    title: describeClaudeTool(name, input) || name,
    input: inputText(name, input),
    status,
    output: output ? clip(output) : null,
    diffs: inputDiffs(name, input),
    ...(name === 'Bash' && (status === 'done' || status === 'failed') ? { execution: { status: status === 'done' ? 'completed' as const : 'failed' as const, exitCode: null } } : {})
  }
}

// A ZCode session as Conclave's chat shows one: each turn's message, what the model said and did,
// and how the turn ended.
export function zcodeTranscript(file: string, sessionId: string): Transcript {
  const db = open(file)
  let rows: unknown[]
  try {
    rows = db.prepare(`
      SELECT m.id AS message, m.time_created AS at, m.data, p.id AS part, p.data AS partData
      FROM message m LEFT JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.time_created, m.sequence, p.sequence`).all(sessionId)
  } finally {
    db.close()
  }
  const entries: TranscriptEntry[] = []
  const messages: TranscriptMessage[] = []
  type Turn = { id: string; ref: string | null; startedAt: number; endedAt: number; reply: string | null; failed: boolean }
  const turns = new Map<string, Turn>()
  const users = new Map<string, { at: number; texts: string[] }>()
  for (const raw of rows) {
    const row = Row.safeParse(raw)
    if (!row.success) continue
    const data = MessageData.safeParse(json(row.data.data)).data
    if (!data) continue
    const turnId = data.anchor?.turnId ?? row.data.message
    let turn = turns.get(turnId)
    if (!turn) {
      turn = { id: turnId, ref: null, startedAt: row.data.at, endedAt: row.data.at, reply: null, failed: false }
      turns.set(turnId, turn)
    }
    turn.endedAt = Math.max(turn.endedAt, row.data.at)
    const part = row.data.partData ? PartData.safeParse(json(row.data.partData)).data : undefined
    if (typed(data)) {
      if (part?.type !== 'text' || !part.text?.trim()) continue
      const user = users.get(row.data.message) ?? { at: row.data.at, texts: [] }
      user.texts.push(part.text)
      users.set(row.data.message, user)
      turn.ref ??= row.data.message
      continue
    }
    if (data.role !== 'assistant' || !part || !row.data.part) continue
    if (part.type === 'text' && part.text?.trim()) {
      entries.push({ at: row.data.at, item: { id: `m:${row.data.part}`, kind: 'assistant', text: part.text, streaming: false } })
      turn.reply = part.text
    } else if (part.type === 'reasoning' && part.text?.trim()) {
      entries.push({ at: row.data.at, item: { id: `r:${row.data.part}`, kind: 'reasoning', text: part.text, streaming: false } })
    } else if (part.type === 'tool') {
      const item = toolItem(`t:${part.callID ?? row.data.part}`, part)
      if (item) entries.push({ at: row.data.at, item })
    } else if (part.type === 'compaction') {
      entries.push({ at: row.data.at, item: { id: `n:${row.data.part}`, kind: 'notice', level: 'info', text: CONTEXT_COMPACTED } })
    }
    if (data.error) turn.failed = true
  }
  for (const [message, user] of users) {
    const text = user.texts.join('\n')
    entries.push({ at: user.at, item: { id: `u:${message}`, kind: 'user', text, images: [] } })
    messages.push({ at: user.at, role: 'user', text, ref: message })
  }
  for (const turn of turns.values()) {
    if (!turn.ref) continue
    entries.push({ at: turn.endedAt, item: { id: `turn:${turn.id}`, kind: 'turn', state: turn.failed ? 'failed' : 'completed', error: null, durationMs: turn.endedAt - turn.startedAt, usage: null, providerRef: turn.id } })
    if (turn.reply) messages.push({ at: turn.endedAt, role: 'assistant', text: turn.reply, ref: turn.ref })
  }
  // A user message sorts before what answered it, even where both carry the same time.
  const rank = (entry: TranscriptEntry) => (entry.item.kind === 'user' ? 0 : entry.item.kind === 'turn' ? 2 : 1)
  return { entries: entries.sort((a, b) => a.at - b.at || rank(a) - rank(b)), messages: messages.sort((a, b) => a.at - b.at) }
}

export function zcodeTranscripts(file: () => string = () => zcodeSessionDb()): TranscriptSource {
  return {
    scan: async () => {
      const db = file()
      if (!(await stat(db).catch(() => null))?.isFile()) return []
      return scanSessions(db)
    },
    read: async (ref) => {
      const at = ref.lastIndexOf('#')
      return zcodeTranscript(ref.slice(0, at), ref.slice(at + 1))
    }
  }
}
