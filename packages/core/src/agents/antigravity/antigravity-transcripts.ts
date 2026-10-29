import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseLine, readHead, readLines, SummaryCache, timeOf, titleOf, type Transcript, type TranscriptEntry, type TranscriptMessage, type TranscriptSource, type TranscriptSummary } from '../../agent-transcripts'

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function antigravityBrainRoot(): string {
  return path.join(homedir(), '.gemini', 'antigravity', 'brain')
}

async function summarizeAntigravitySession(brainDir: string, sessionId: string, mtimeMs: number): Promise<TranscriptSummary | null> {
  const file = path.join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl')
  if (!(await stat(file).catch(() => null))?.isFile()) return null

  let title = 'Antigravity 会话'
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
      title = titleOf(content)
      if (typeof raw.created_at === 'string') startedAt = timeOf(raw.created_at) ?? startedAt
      return false
    }
    return true
  })

  return {
    sessionId,
    cwd: homedir(),
    title,
    named: false,
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
      const id = `agy:u:${raw.step_index ?? crypto.randomUUID()}`
      entries.push({ at, item: { id, kind: 'user', text, images: [] } })
      messages.push({ at, role: 'user', text, ref: id })
    } else if (raw.type === 'PLANNER_RESPONSE') {
      const id = `agy:a:${raw.step_index ?? crypto.randomUUID()}`
      if (typeof raw.thinking === 'string' && raw.thinking.trim()) {
        entries.push({ at, item: { id: `think:${id}`, kind: 'reasoning', text: raw.thinking, streaming: false } })
      }
      if (typeof raw.content === 'string' && raw.content.trim()) {
        entries.push({ at, item: { id, kind: 'assistant', text: raw.content, streaming: false } })
        messages.push({ at, role: 'assistant', text: raw.content, ref: id })
      }
    }
  }

  return { entries, messages }
}

export function antigravityTranscripts(root: () => string = antigravityBrainRoot): TranscriptSource {
  const cache = new SummaryCache()
  return {
    scan: async () => {
      const dir = root()
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const dirs = entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && UUID_DIR.test(e.name))
      const summaries = await Promise.all(dirs.map(async (d) => {
        const info = await stat(path.join(dir, d.name)).catch(() => null)
        if (!info) return null
        return cache.get({ file: path.join(dir, d.name), mtimeMs: info.mtimeMs, size: 0 }, () => summarizeAntigravitySession(dir, d.name, info.mtimeMs))
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
      // file is ~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl
      // or directory
      const brainDir = root()
      const parts = path.relative(brainDir, file).split(path.sep)
      const sessionId = parts[0]
      if (sessionId && UUID_DIR.test(sessionId)) {
        await rm(path.join(brainDir, sessionId), { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}
