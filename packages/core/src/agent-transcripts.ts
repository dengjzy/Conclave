import { createReadStream, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { createZstdDecompress } from 'node:zlib'
import type { ChatItemBody } from './chat-items'

// A session an agent kept in its own transcript, as a quick look at the file tells it.
export type TranscriptSummary = {
  sessionId: string
  cwd: string
  title: string
  // The user named it (Claude's /rename): the title stays what they chose.
  named: boolean
  firstPrompt: string
  startedAt: number
  // When the file last changed: the session's last activity.
  modifiedAt: number
  file: string
}

// One thing the transcript shows, as Conclave's chat would: its id is the same on every read.
export type TranscriptEntry = { at: number; item: ChatItemBody }
// A user message or a turn's final reply, for conversation_messages; ref is its user item's.
export type TranscriptMessage = { at: number; role: 'user' | 'assistant'; text: string; ref: string }

export type Transcript = { entries: TranscriptEntry[]; messages: TranscriptMessage[] }

// How an agent's own record of the sessions it ran outside Conclave is read.
export interface TranscriptSource {
  scan(): Promise<TranscriptSummary[]>
  read(file: string): Promise<Transcript>
}

const HEAD_BYTES = 256 * 1024

// The lines of a transcript, decompressed where Codex packed it, while `take` wants more. A
// line cut short by the byte limit is left out.
export async function readLines(file: string, take: (line: string) => boolean, limit = Infinity): Promise<void> {
  const raw = createReadStream(file)
  const input = file.endsWith('.zst') ? raw.pipe(createZstdDecompress()) : raw
  const lines = createInterface({ input, crlfDelay: Infinity })
  let read = 0
  try {
    for await (const line of lines) {
      read += Buffer.byteLength(line) + 1
      if (read > limit || !take(line)) break
    }
  } catch {
    // An unreadable or truncated file reads as far as it went.
  } finally {
    lines.close()
    raw.destroy()
    if (input !== raw) input.destroy()
  }
}

// The start of a transcript, for its summary; a huge first message stops it early.
export function readHead(file: string, take: (line: string) => boolean): Promise<void> {
  return readLines(file, take, HEAD_BYTES)
}

export function parseLine(line: string): unknown {
  try {
    return line.trim() ? JSON.parse(line) : null
  } catch {
    return null
  }
}

export function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

// The files under a folder whose names pass, at any depth up to `depth`, with when each changed.
export async function findFiles(root: string, depth: number, wanted: (name: string) => boolean, skipDir: (name: string) => boolean = () => false): Promise<Array<{ file: string; mtimeMs: number; size: number }>> {
  const found: Array<{ file: string; mtimeMs: number; size: number }> = []
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (left > 0 && !skipDir(entry.name)) await walk(full, left - 1)
        if (entry.isDirectory()) return
      }
      if (!wanted(entry.name)) return
      try {
        const info = await stat(full)
        if (info.isFile()) found.push({ file: full, mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        // Gone since the listing.
      }
    }))
  }
  await walk(root, depth)
  return found
}

// Summaries kept while their file stays the same size and age, so a second scan reads only what changed.
export class SummaryCache {
  private readonly kept = new Map<string, { mtimeMs: number; size: number; summary: TranscriptSummary | null }>()

  async get(file: { file: string; mtimeMs: number; size: number }, read: () => Promise<TranscriptSummary | null>): Promise<TranscriptSummary | null> {
    const known = this.kept.get(file.file)
    if (known && known.mtimeMs === file.mtimeMs && known.size === file.size) return known.summary
    const summary = await read()
    this.kept.set(file.file, { mtimeMs: file.mtimeMs, size: file.size, summary })
    return summary
  }
}

// The first line of a prompt, short enough for a title.
export function titleOf(text: string, max = 80): string {
  const line = text.trim().split('\n').find((each) => each.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line.trim()
}
