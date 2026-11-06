import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { clip, type ChatItemBody } from '../../chat-items'
import { findFiles, parseLine, readHead, readLines, SummaryCache, timeOf, titleOf, type Transcript, type TranscriptEntry, type TranscriptMessage, type TranscriptSource, type TranscriptSummary } from '../../agent-transcripts'

const DSH_SESSION_FILE = /^session(\.v\d+)?\.jsonl(\.zstd|\.zst)?$/i

export function dshSessionsRoot(): string {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'sessions')
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => {
      if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && typeof part.text === 'string') {
        return [part.text]
      }
      return []
    })
    .join('\n')
    .trim()
}

async function summarizeDshSession(file: string, mtimeMs: number): Promise<TranscriptSummary | null> {
  let sessionId: string | null = null
  let cwd: string = homedir()
  let title: string | null = null
  let named = false
  let firstPrompt = ''
  let startedAt = mtimeMs

  await readHead(file, (line) => {
    const raw = parseLine(line) as Record<string, unknown> | null
    if (!raw) return true

    if (raw.type === 'session') {
      if (typeof raw.id === 'string') sessionId = raw.id
      if (typeof raw.cwd === 'string') cwd = raw.cwd
      if (typeof raw.createdAt === 'number') startedAt = raw.createdAt
      else if (typeof raw.timestamp === 'string') startedAt = timeOf(raw.timestamp) ?? startedAt
    } else if (raw.type === 'session/title') {
      const data = raw.data as Record<string, unknown> | undefined
      if (data && typeof data.title === 'string' && data.title.trim()) {
        title = data.title.trim()
        const src = data.source as Record<string, unknown> | undefined
        named = src?.kind === 'user'
      }
    } else if (raw.type === 'user/message') {
      const data = raw.data as Record<string, unknown> | undefined
      const src = data?.source as Record<string, unknown> | undefined
      // Only real user prompts count, not plugin context or system snapshots
      if (!src || src.kind === 'user') {
        const msg = data?.message as Record<string, unknown> | undefined
        const text = textOfContent(data?.content ?? msg?.content)
        if (text && !firstPrompt) {
          firstPrompt = text
          if (!title) title = titleOf(text)
        }
      }
    }
    return true
  })

  if (!sessionId) {
    // If first line wasn't session header, try deriving from folder name
    const match = path.basename(path.dirname(file)).match(/^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
    if (match) sessionId = path.basename(path.dirname(file))
  }

  if (!sessionId) return null
  return {
    sessionId,
    cwd,
    title: title || 'DSH 会话',
    named,
    firstPrompt,
    startedAt,
    modifiedAt: mtimeMs,
    file
  }
}

export function dshTranscript(lines: string[]): Transcript {
  const entries: TranscriptEntry[] = []
  const messages: TranscriptMessage[] = []
  const toolResults = new Map<string, { text: string; isError?: boolean }>()
  let at = Date.now()

  // First pass: index tool results
  for (const line of lines) {
    const raw = parseLine(line) as Record<string, unknown> | null
    if (!raw) continue

    if (raw.type === 'tool/result') {
      const data = raw.data as Record<string, unknown> | undefined
      const msg = data?.message as Record<string, unknown> | undefined
      const contents = Array.isArray(msg?.content) ? msg.content : []
      for (const item of contents) {
        if (item && typeof item === 'object' && item.type === 'tool-result' && typeof item.toolCallId === 'string') {
          const resText = textOfContent(item.content)
          toolResults.set(item.toolCallId, { text: resText, isError: Boolean(item.isError) })
        }
      }
    }
  }

  // Second pass: construct messages and items
  for (const line of lines) {
    const raw = parseLine(line) as Record<string, unknown> | null
    if (!raw) continue
    if (typeof raw.time === 'number') at = raw.time
    else if (typeof raw.timestamp === 'string') at = timeOf(raw.timestamp) ?? at
    else if (typeof raw.createdAt === 'number') at = raw.createdAt

    if (raw.type === 'user/message') {
      const data = raw.data as Record<string, unknown> | undefined
      const src = data?.source as Record<string, unknown> | undefined
      if (src && src.kind !== 'user') continue // skip system/plugin snapshots
      const msg = data?.message as Record<string, unknown> | undefined
      const text = textOfContent(data?.content ?? msg?.content)
      if (!text) continue
      const id = typeof data?.id === 'string' ? data.id : typeof raw.seq === 'number' ? `dsh:${raw.seq}` : crypto.randomUUID()
      entries.push({ at, item: { id: `u:${id}`, kind: 'user', text, images: [] } })
      messages.push({ at, role: 'user', text, ref: id })
    } else if (raw.type === 'assistant/message') {
      const data = raw.data as Record<string, unknown> | undefined
      const msg = data?.message as Record<string, unknown> | undefined
      const contents = Array.isArray(msg?.content) ? msg.content : []
      const msgId = typeof msg?.id === 'string' ? msg.id : typeof raw.seq === 'number' ? `dsh:${raw.seq}` : crypto.randomUUID()
      let partIdx = 0

      for (const part of contents) {
        if (!part || typeof part !== 'object') continue
        if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
          entries.push({ at, item: { id: `r:${msgId}-${partIdx++}`, kind: 'reasoning', text: part.text.trim(), streaming: false } })
        } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          const text = part.text.trim()
          entries.push({ at, item: { id: `a:${msgId}-${partIdx++}`, kind: 'assistant', text, streaming: false } })
          messages.push({ at, role: 'assistant', text, ref: msgId })
        } else if (part.type === 'tool-call') {
          const callId = typeof part.id === 'string' ? part.id : `call_${partIdx++}`
          const name = typeof part.name === 'string' ? part.name : 'tool'
          const args = typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments ?? {})
          const result = toolResults.get(callId)
          let title = name
          let description: string | null = null
          try {
            const parsed = JSON.parse(args)
            if (parsed.command) title = parsed.command
            if (parsed.description) description = parsed.description
          } catch {}

          const item: ChatItemBody = {
            id: `t:${callId}`,
            kind: 'tool',
            name,
            title,
            description,
            input: args,
            status: 'done',
            output: result ? clip(result.text) : null,
            execution: result ? { status: result.isError ? 'failed' : 'completed', exitCode: result.isError ? 1 : 0 } : undefined,
            diffs: []
          }
          entries.push({ at, item })
        }
      }
    }
  }

  return { entries, messages }
}

export function dshTranscripts(root: () => string = dshSessionsRoot): TranscriptSource {
  const cache = new SummaryCache()
  return {
    scan: async () => {
      const dir = root()
      const files = await findFiles(dir, 3, (name) => DSH_SESSION_FILE.test(name) || name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))
      const summaries = await Promise.all(files.map((file) => cache.get(file, () => summarizeDshSession(file.file, file.mtimeMs))))
      return summaries.flatMap((s) => (s ? [s] : []))
    },
    read: async (file) => {
      const lines: string[] = []
      await readLines(file, (line) => {
        lines.push(line)
        return true
      })
      return dshTranscript(lines)
    },
    delete: async (file) => {
      await rm(file, { force: true }).catch(() => {})
      const dir = path.dirname(file)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
