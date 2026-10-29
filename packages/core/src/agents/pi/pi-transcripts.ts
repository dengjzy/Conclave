import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { findFiles, parseLine, readHead, readLines, SummaryCache, timeOf, titleOf, type Transcript, type TranscriptEntry, type TranscriptMessage, type TranscriptSource, type TranscriptSummary } from '../../agent-transcripts'

const PI_SESSION_FILE = /^[0-9T_-]+_[0-9a-f-]+\.jsonl$/i

export function piSessionsRoot(): string {
  return path.join(homedir(), '.pi', 'agent', 'sessions')
}

async function summarizePiSession(file: string, mtimeMs: number): Promise<TranscriptSummary | null> {
  let sessionId: string | null = null
  let cwd: string = homedir()
  let title = 'Pi 会话'
  let firstPrompt = ''
  let startedAt = mtimeMs

  await readHead(file, (line) => {
    const raw = parseLine(line) as Record<string, unknown> | null
    if (!raw) return true
    if (raw.type === 'session') {
      if (typeof raw.id === 'string') sessionId = raw.id
      if (typeof raw.cwd === 'string') cwd = raw.cwd
      if (typeof raw.timestamp === 'string') startedAt = timeOf(raw.timestamp) ?? startedAt
    } else if (raw.type === 'message') {
      const msg = raw.message as Record<string, unknown> | undefined
      if (msg && msg.role === 'user' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
            firstPrompt = part.text
            title = titleOf(part.text)
            return false // found first user prompt, done with summary
          }
        }
      }
    }
    return true
  })

  if (!sessionId) return null
  return {
    sessionId,
    cwd,
    title,
    named: false,
    firstPrompt,
    startedAt,
    modifiedAt: mtimeMs,
    file
  }
}

function piTranscript(lines: string[]): Transcript {
  const entries: TranscriptEntry[] = []
  const messages: TranscriptMessage[] = []
  let at = Date.now()

  for (const line of lines) {
    const raw = parseLine(line) as Record<string, unknown> | null
    if (!raw) continue
    if (typeof raw.timestamp === 'string') {
      at = timeOf(raw.timestamp) ?? at
    }

    if (raw.type === 'message') {
      const msg = raw.message as Record<string, unknown> | undefined
      if (!msg || typeof msg.role !== 'string') continue
      const role = msg.role === 'user' ? 'user' : 'assistant'
      const id = typeof raw.id === 'string' ? raw.id : `pi:${crypto.randomUUID()}`

      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
            const text = part.text.trim()
            if (!text) continue
            if (role === 'user') {
              entries.push({ at, item: { id: `u:${id}`, kind: 'user', text, images: [] } })
              messages.push({ at, role: 'user', text, ref: id })
            } else {
              entries.push({ at, item: { id: `a:${id}`, kind: 'assistant', text, streaming: false } })
              messages.push({ at, role: 'assistant', text, ref: id })
            }
          }
        }
      }
    }
  }

  return { entries, messages }
}

export function piTranscripts(root: () => string = piSessionsRoot): TranscriptSource {
  const cache = new SummaryCache()
  return {
    scan: async () => {
      const dir = root()
      const files = await findFiles(dir, 2, (name) => PI_SESSION_FILE.test(name) || name.endsWith('.jsonl'))
      const summaries = await Promise.all(files.map((file) => cache.get(file, () => summarizePiSession(file.file, file.mtimeMs))))
      return summaries.flatMap((s) => (s ? [s] : []))
    },
    read: async (file) => {
      const lines: string[] = []
      await readLines(file, (line) => {
        lines.push(line)
        return true
      })
      return piTranscript(lines)
    },
    delete: async (file) => {
      await rm(file, { force: true })
      const dir = file.replace(/\.jsonl$/, '')
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
