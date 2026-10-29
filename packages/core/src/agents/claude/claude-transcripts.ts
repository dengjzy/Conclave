import path from 'node:path'
import { CONTEXT_COMPACTED } from '@conclave/protocol'
import { z } from 'zod'
import { clip, type ChatItemBody } from '../../chat-items'
import { findFiles, parseLine, readHead, readLines, SummaryCache, timeOf, titleOf, type Transcript, type TranscriptEntry, type TranscriptMessage, type TranscriptSource, type TranscriptSummary } from '../../agent-transcripts'
import { claudeDefaultHome } from './claude-account'
import { COMMAND_TOOLS, describeClaudeTool, HAND_BACK, HIDDEN_TOOLS, inputDiffs, inputText, resultDiffs, toolResult } from './claude-stream'

// Claude Code keeps each session in projects/<its folder, dashed>/<session id>.jsonl, one record
// a line: the user's and the model's messages, each content block of a reply on a line of its own,
// chained by parentUuid; and records of its own (titles, snapshots, queue operations).
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

const Block = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional()
})
type Block = z.infer<typeof Block>
const Blocks = z.array(z.unknown()).transform((blocks) => blocks.flatMap((block) => {
  const parsed = Block.safeParse(block)
  return parsed.success ? [parsed.data] : []
}))
const Line = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullish(),
  // A compaction starts a new chain; this names where the old one ended.
  logicalParentUuid: z.string().nullish(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  subtype: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  message: z.looseObject({ content: z.union([z.string(), Blocks]).catch('') }).optional(),
  toolUseResult: z.unknown().optional(),
  customTitle: z.string().optional(),
  aiTitle: z.string().optional(),
  summary: z.string().optional()
})
type Line = z.infer<typeof Line>
const Input = z.record(z.string(), z.unknown()).catch({})

function lineOf(text: string): Line | null {
  const parsed = Line.safeParse(parseLine(text))
  return parsed.success ? parsed.data : null
}

// Turns Claude Code adds as the user's that the user never typed: a command's output, a reminder,
// a background task's report. Only tags it is known to write count, so a prompt that happens to
// open with a tag of its own still reads as one.
const HARNESS_PREFIXES = [
  '<local-command-', '<system-reminder>', '<task-notification>', '<bash-input>', '<bash-stdout>', '<bash-stderr>',
  '<user-prompt-submit-hook>', '<command-message>', 'caveat: the messages below were generated', '[request interrupted'
]
const INTERRUPTED = '[request interrupted'
const COMMAND = /<command-name>\/?([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

// What the user typed, or null for a turn that is not a prompt: a tool's result, or the CLI's own.
export function claudePrompt(line: Line): string | null {
  if (line.type !== 'user' || line.isMeta || line.isCompactSummary || line.isSidechain || !line.message) return null
  const { content } = line.message
  let text: string
  if (typeof content === 'string') {
    text = content
  } else {
    if (content.some((block) => block.type === 'tool_result')) return null
    text = content.map((block) => (block.type === 'text' ? block.text ?? '' : block.type === 'image' ? '[图片]' : '')).filter(Boolean).join('\n')
  }
  const command = COMMAND.exec(text)
  if (command) return `/${command[1]!.trim()} ${COMMAND_ARGS.exec(text)?.[1]?.trim() ?? ''}`.trim()
  const head = text.trimStart().toLowerCase()
  if (!head || HARNESS_PREFIXES.some((prefix) => head.startsWith(prefix))) return null
  return text.trim()
}

function interrupted(line: Line): boolean {
  if (line.type !== 'user' || !line.message) return false
  const { content } = line.message
  const text = typeof content === 'string' ? content : content.map((block) => block.text ?? '').join('')
  return text.trimStart().toLowerCase().startsWith(INTERRUPTED)
}

export async function summarizeClaudeTranscript(file: string, mtimeMs: number): Promise<TranscriptSummary | null> {
  const head: { cwd: string | null; startedAt: number | null; prompt: string | null; custom: string | null; ai: string | null; summary: string | null } =
    { cwd: null, startedAt: null, prompt: null, custom: null, ai: null, summary: null }
  await readHead(file, (text) => {
    const line = lineOf(text)
    if (!line) return true
    if (line.type === 'custom-title' && line.customTitle?.trim()) head.custom = line.customTitle.trim()
    else if (line.type === 'ai-title' && line.aiTitle?.trim()) head.ai = line.aiTitle.trim()
    else if (line.type === 'summary' && line.summary?.trim()) head.summary ??= line.summary.trim()
    if (line.isSidechain) return true
    head.cwd ??= line.cwd ?? null
    head.startedAt ??= timeOf(line.timestamp)
    head.prompt ??= claudePrompt(line)
    return true
  })
  const { cwd, prompt, custom } = head
  if (!cwd || prompt === null) return null
  return {
    sessionId: path.basename(file, '.jsonl'),
    cwd,
    title: custom ?? head.ai ?? head.summary ?? titleOf(prompt),
    named: custom !== null,
    firstPrompt: titleOf(prompt, 200),
    startedAt: head.startedAt ?? mtimeMs,
    modifiedAt: mtimeMs,
    file
  }
}

// The records on the session's current branch: back from its last message along the chain, so a
// branch left by rewinding drops out. Sidechains (a subagent's own talk) are never on it.
function trunk(lines: readonly Line[]): Set<string> {
  const byId = new Map(lines.flatMap((line) => (line.uuid ? [[line.uuid, line] as const] : [])))
  const last = lines.findLast((line) => line.uuid && !line.isSidechain && (line.type === 'user' || line.type === 'assistant'))
  const kept = new Set<string>()
  let current = last
  while (current?.uuid && !kept.has(current.uuid)) {
    kept.add(current.uuid)
    const parent = current.parentUuid ?? current.logicalParentUuid
    current = parent ? byId.get(parent) : undefined
  }
  return kept
}

type Result = { block: Block; raw: unknown }

function toolItem(block: Block, result: Result | undefined): ChatItemBody | null {
  const name = block.name ?? 'tool'
  if (!block.id || HIDDEN_TOOLS.has(name)) return null
  const input = Input.parse(block.input ?? {})
  const diffs = inputDiffs(name, input)
  const description = COMMAND_TOOLS.has(name) && typeof input.description === 'string' ? input.description.trim() || null : null
  const base = { id: `t:${block.id}`, kind: 'tool' as const, name, title: describeClaudeTool(name, input), description, input: inputText(name, input), diffs }
  // No result: the session stopped while it ran.
  if (!result) return { ...base, status: 'interrupted', output: null }
  const failed = result.block.is_error === true
  const output = toolResult(result.block.content).text.replace(HAND_BACK, '').replace(/^ {2}/gm, '')
  return {
    ...base,
    status: failed ? 'failed' : 'done',
    ...(name === 'Bash' && !failed ? { execution: { status: 'completed' as const, exitCode: null } } : {}),
    output: output ? clip(output) : null,
    diffs: failed ? diffs : resultDiffs(diffs, result.raw)
  }
}

// A Claude Code session as Conclave's chat shows one: the user's prompts, the replies, thinking and
// tool calls with their results, a turn closing each prompt.
export function claudeTranscript(texts: readonly string[]): Transcript {
  const lines = texts.flatMap((text) => {
    const line = lineOf(text)
    return line ? [line] : []
  })
  const kept = trunk(lines)
  // Results by call, from wherever they sit: parallel calls answer on sibling branches.
  const results = new Map<string, Result>()
  for (const line of lines) {
    const content = line.type === 'user' ? line.message?.content : undefined
    if (!Array.isArray(content)) continue
    for (const block of content) if (block.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, { block, raw: line.toolUseResult })
  }
  const entries: TranscriptEntry[] = []
  const messages: TranscriptMessage[] = []
  let turn: { ref: string; startedAt: number; endedAt: number; reply: string | null; last: string | null; interrupted: boolean } | null = null
  const close = () => {
    if (!turn) return
    entries.push({ at: turn.endedAt, item: { id: `turn:${turn.ref}`, kind: 'turn', state: turn.interrupted ? 'interrupted' : 'completed', error: null, durationMs: turn.endedAt - turn.startedAt, usage: null, providerRef: turn.last } })
    if (turn.reply) messages.push({ at: turn.endedAt, role: 'assistant', text: turn.reply, ref: turn.ref })
    turn = null
  }
  for (const line of lines) {
    if (!line.uuid || !kept.has(line.uuid)) continue
    const at = timeOf(line.timestamp) ?? 0
    if (line.type === 'system' && line.subtype === 'compact_boundary') {
      entries.push({ at, item: { id: `n:${line.uuid}`, kind: 'notice', level: 'info', text: CONTEXT_COMPACTED } })
      continue
    }
    if (line.type === 'user') {
      if (interrupted(line) && turn) turn.interrupted = true
      const prompt = claudePrompt(line)
      if (prompt === null) continue
      close()
      turn = { ref: line.uuid, startedAt: at, endedAt: at, reply: null, last: null, interrupted: false }
      entries.push({ at, item: { id: `u:${line.uuid}`, kind: 'user', text: prompt, images: [] } })
      messages.push({ at, role: 'user', text: prompt, ref: line.uuid })
      continue
    }
    if (line.type !== 'assistant' || !line.message || typeof line.message.content === 'string') continue
    line.message.content.forEach((block, index) => {
      const id = `c:${line.uuid}:${index}`
      if (block.type === 'text' && block.text?.trim()) {
        entries.push({ at, item: { id, kind: 'assistant', text: block.text, streaming: false } })
        if (turn) turn.reply = block.text
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        entries.push({ at, item: { id, kind: 'reasoning', text: block.thinking, streaming: false } })
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        const item = toolItem(block, block.id ? results.get(block.id) : undefined)
        if (item) entries.push({ at, item })
      }
    })
    if (turn) {
      turn.endedAt = Math.max(turn.endedAt, at)
      turn.last = line.uuid
    }
  }
  close()
  return { entries, messages }
}

export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeDefaultHome(env), 'projects')
}

export function claudeTranscripts(root: () => string = () => claudeProjectsRoot()): TranscriptSource {
  const cache = new SummaryCache()
  return {
    // A session's subagents sit in a folder named after it, and are no session of their own.
    scan: async () => {
      const files = await findFiles(root(), 1, (name) => SESSION_FILE.test(name))
      const summaries = await Promise.all(files.map((file) => cache.get(file, () => summarizeClaudeTranscript(file.file, file.mtimeMs))))
      return summaries.flatMap((summary) => (summary ? [summary] : []))
    },
    read: async (file) => {
      const texts: string[] = []
      await readLines(file, (text) => {
        texts.push(text)
        return true
      })
      return claudeTranscript(texts)
    }
  }
}
