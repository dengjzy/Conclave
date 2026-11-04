import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parseLine, readHead, readLines, SummaryCache, timeOf, titleOf, type Transcript, type TranscriptEntry, type TranscriptMessage, type TranscriptSource, type TranscriptSummary } from '../../agent-transcripts'

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function antigravityBrainRoot(): string {
  return path.join(homedir(), '.gemini', 'antigravity', 'brain')
}

export function antigravitySummariesDb(brainRoot = antigravityBrainRoot()): string {
  return path.join(path.dirname(brainRoot), 'conversation_summaries.db')
}

export function parseAntigravityWorkspace(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (typeof first === 'string' && first.startsWith('file:')) {
      return fileURLToPath(first)
    }
  } catch {
    if (raw.startsWith('file:')) {
      try {
        return fileURLToPath(raw)
      } catch {}
    }
  }
  return null
}

interface AntigravitySessionMetadata {
  cwd: string | null
  title: string | null
  isSubagent: boolean
}

function cleanPromptForTitle(text: string): string {
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^#+\s*/, '')
  cleaned = cleaned.replace(/^\d+[\.\)]\s*/, '')
  cleaned = cleaned.replace(/^\[([^\]]+)\]\([^\)]+\)/, '$1')
  cleaned = cleaned.replace(/^https?:\/\/\S+\s+/, '')
  return cleaned.trim() || text.trim()
}

function readSummariesMetadata(dbPath: string): Map<string, AntigravitySessionMetadata> {
  const map = new Map<string, AntigravitySessionMetadata>()
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT * FROM conversation_summaries').all() as Array<Record<string, unknown>>
    for (const row of rows) {
      if (typeof row.conversation_id === 'string') {
        const parentId = typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.trim() : ''
        const depth = typeof row.nesting_depth === 'number' ? row.nesting_depth : 0
        const isSubagent = Boolean(parentId || depth > 0)
        const workspace = typeof row.workspace_uris === 'string' ? row.workspace_uris : null
        const title = typeof row.title === 'string' ? row.title.trim() : null
        map.set(row.conversation_id, {
          cwd: parseAntigravityWorkspace(workspace),
          title: title || null,
          isSubagent
        })
      }
    }
    db.close()
  } catch {}
  return map
}

async function summarizeAntigravitySession(brainDir: string, sessionId: string, mtimeMs: number, meta?: AntigravitySessionMetadata): Promise<TranscriptSummary | null> {
  const file = path.join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl')
  if (!(await stat(file).catch(() => null))?.isFile()) return null

  let title = meta?.title || 'Antigravity 会话'
  let firstPrompt = ''
  let startedAt = mtimeMs

  await readHead(file, (line) => {
    const raw = parseLine(line) as Record<string, unknown> | null
    if (!raw) return true
    if (raw.type === 'USER_INPUT' && typeof raw.content === 'string') {
      let content = raw.content
      const requestMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)
      if (requestMatch?.[1]) content = requestMatch[1].trim()
      firstPrompt = content
      if (!meta?.title) {
        title = titleOf(cleanPromptForTitle(content))
      }
      if (typeof raw.created_at === 'string') startedAt = timeOf(raw.created_at) ?? startedAt
      return false
    }
    return true
  })

  return {
    sessionId,
    cwd: meta?.cwd ?? homedir(),
    title,
    named: Boolean(meta?.title),
    firstPrompt,
    startedAt,
    modifiedAt: mtimeMs,
    file
  }
}

function antigravityTranscript(lines: string[]): Transcript {
  const entries: TranscriptEntry[] = []
  const messages: TranscriptMessage[] = []
  let at = Date.now()

  for (const line of lines) {
    const raw = parseLine(line) as Record<string, unknown> | null
    if (!raw) continue
    if (typeof raw.created_at === 'string') at = timeOf(raw.created_at) ?? at

    if (raw.type === 'USER_INPUT' && typeof raw.content === 'string') {
      let text = raw.content
      const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text)
      if (match?.[1]) text = match[1].trim()
      const id = 'agy:u:' + String(raw.step_index ?? crypto.randomUUID())
      entries.push({ at, item: { id, kind: 'user', text, images: [] } })
      messages.push({ at, role: 'user', text, ref: id })
    } else if (raw.type === 'PLANNER_RESPONSE') {
      const id = 'agy:a:' + String(raw.step_index ?? crypto.randomUUID())
      if (typeof raw.thinking === 'string' && raw.thinking.trim()) {
        entries.push({ at, item: { id: 'think:' + id, kind: 'reasoning', text: raw.thinking, streaming: false } })
      }
      if (typeof raw.content === 'string' && raw.content.trim()) {
        entries.push({ at, item: { id, kind: 'assistant', text: raw.content, streaming: false } })
        messages.push({ at, role: 'assistant', text: raw.content, ref: id })
      }
    }
  }

  return { entries, messages }
}

export function antigravityTranscripts(root: () => string = antigravityBrainRoot, summariesDb: () => string = () => antigravitySummariesDb(root())): TranscriptSource {
  const cache = new SummaryCache()
  return {
    scan: async () => {
      const dir = root()
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const dirs = entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && UUID_DIR.test(e.name))
      const metadata = readSummariesMetadata(summariesDb())
      const summaries = await Promise.all(dirs.map(async (d) => {
        const info = await stat(path.join(dir, d.name)).catch(() => null)
        if (!info) return null
        const meta = metadata.get(d.name)
        if (meta?.isSubagent) return null
        return cache.get({ file: path.join(dir, d.name), mtimeMs: info.mtimeMs, size: 0 }, () => summarizeAntigravitySession(dir, d.name, info.mtimeMs, meta))
      }))
      return summaries.flatMap((s) => (s ? [s] : []))
    },
    read: async (file) => {
      const lines: string[] = []
      await readLines(file, (line) => {
        lines.push(line)
        return true
      })
      return antigravityTranscript(lines)
    },
    delete: async (file) => {
      const brainDir = root()
      const parts = path.relative(brainDir, file).split(path.sep)
      const sessionId = parts[0]
      if (!sessionId || !UUID_DIR.test(sessionId)) return

      // Remove brain directory
      await rm(path.join(brainDir, sessionId), { recursive: true, force: true }).catch(() => {})

      // Remove individual conversation SQLite database if present
      const conversationsDir = path.join(path.dirname(brainDir), 'conversations')
      await rm(path.join(conversationsDir, `${sessionId}.db`), { force: true }).catch(() => {})
      await rm(path.join(conversationsDir, `${sessionId}.db-wal`), { force: true }).catch(() => {})
      await rm(path.join(conversationsDir, `${sessionId}.db-shm`), { force: true }).catch(() => {})

      // Clean up summaries and search index
      try {
        const dbPath = summariesDb()
        const db = new DatabaseSync(dbPath)
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(sessionId)
        try {
          db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(sessionId)
        } catch {}
        db.close()
      } catch {}
    }
  }
}
