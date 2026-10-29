import { createReadStream } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createZstdDecompress } from 'node:zlib'
import { z } from 'zod'
import { type UsageEvent } from '@conclave/protocol'
import { findFiles } from './agent-transcripts'
import { emptyParser, fingerprint, ParserState, parseUsageLine, usageEvent } from './usage-events'

export const ScanCheckpoint = z.object({
  size: z.number(), mtime: z.number(), fileId: z.string(), offset: z.number(), head: z.string(), boundary: z.string(), state: ParserState,
  skipping: z.boolean().default(false)
})
export type ScanCheckpoint = z.infer<typeof ScanCheckpoint>
export type ScanRoot = { agent: 'claude' | 'codex'; home: string }
export type ScanRequest = { roots: ScanRoot[]; checkpoints: Record<string, ScanCheckpoint>; opencode: string[] }
export type ScanFile = { file: string; reset: boolean; events: UsageEvent[]; checkpoint: ScanCheckpoint | null }
const MAX_LINE = 32 * 1024 * 1024

async function digest(file: string, start: number, length: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return fingerprint(buffer.subarray(0, bytesRead).toString('base64'))
  } finally { await handle.close() }
}

export async function scanJsonl(file: string, agent: 'claude' | 'codex', previous: ScanCheckpoint | undefined): Promise<ScanFile | null> {
  const info = await stat(file)
  const fileId = `${info.dev}/${info.ino}`
  if (previous && previous.size === info.size && previous.mtime === info.mtimeMs && previous.fileId === fileId) return null
  const compressed = file.endsWith('.zst')
  const canResume = !compressed && previous && previous.fileId === fileId && info.size >= previous.offset &&
    previous.head === await digest(file, 0, Math.min(previous.offset, 4096)) &&
    previous.boundary === await digest(file, Math.max(0, previous.offset - 4096), Math.min(previous.offset, 4096))
  const start = canResume ? previous.offset : 0
  const state = canResume ? structuredClone(previous.state) : emptyParser()
  const raw = createReadStream(file, { ...(compressed ? {} : { start, end: Math.max(start, info.size - 1) }) })
  const stream = compressed ? raw.pipe(createZstdDecompress()) : raw
  if (compressed) raw.on('error', (error) => stream.destroy(error))
  const events = new Map<string, UsageEvent>()
  let pending = Buffer.alloc(0), consumed = start, skipping = canResume ? previous.skipping : false
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let from = 0
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, from)) {
        const bytes = buffer.subarray(from, end)
        if (!skipping && pending.length + bytes.length <= MAX_LINE) {
          const event = parseUsageLine(agent, Buffer.concat([pending, bytes]).toString('utf8'), state)
          if (event) events.set(event.id, event)
        }
        consumed += pending.length + bytes.length + 1
        pending = Buffer.alloc(0); skipping = false; from = end + 1
      }
      const tail = buffer.subarray(from)
      if (skipping || pending.length + tail.length > MAX_LINE) { consumed += pending.length + tail.length; pending = Buffer.alloc(0); skipping = true }
      else pending = Buffer.concat([pending, tail])
    }
  } finally { raw.destroy(); if (stream !== raw) stream.destroy() }
  const after = await stat(file)
  if (after.ino !== info.ino || after.size < info.size || (after.size === info.size && after.mtimeMs !== info.mtimeMs)) throw new Error('transcript changed while reading')
  const offset = compressed ? info.size : consumed
  return { file, reset: !canResume, events: [...events.values()], checkpoint: {
    fileId, size: info.size, mtime: info.mtimeMs, offset, skipping,
    head: compressed ? '' : await digest(file, 0, Math.min(offset, 4096)),
    boundary: compressed ? '' : await digest(file, Math.max(0, offset - 4096), Math.min(offset, 4096)), state
  } }
}

const OpenMessage = z.looseObject({ role: z.string().optional(), modelID: z.string().optional(), providerID: z.string().optional(),
  modelId: z.string().optional(), providerId: z.string().optional(),
  model: z.unknown().optional(), cost: z.number().nonnegative().optional(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(),
    cache: z.object({ read: z.number().int().nonnegative().optional(), write: z.number().int().nonnegative().optional() }).optional() }).optional()
})
const OpenRow = z.object({ id: z.string(), session: z.string(), at: z.number(), data: z.string(), cwd: z.string().nullable(), model: z.string().nullable() })

export function scanOpenCode(file: string): ScanFile {
  const db = new DatabaseSync(file, { readOnly: true })
  const events: UsageEvent[] = []
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)))
    const sessions = ['session_v2', 'session'].filter((name) => tables.has(name))
    const columns = (table: string) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)))
    const columnSets = new Map(sessions.map((table) => [table, columns(table)]))
    const relation = sessions.map((table, index) => {
      const values = ['directory', 'model', 'time_created', 'time_updated', 'cost', 'tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write']
        .map((name) => {
          const refs = sessions.slice(index).filter((other) => columnSets.get(other)?.has(name)).map((other) => other === table ? `s.${name}` : `(SELECT o.${name} FROM ${other} o WHERE o.id=s.id)`)
          const numeric = name === 'cost' || name.startsWith('tokens_')
          const expression = refs.length === 0 ? 'NULL' : refs.length === 1 ? refs[0] : numeric
            ? `MAX(${refs.map((ref) => `COALESCE(${ref},0)`).join(',')})` : `COALESCE(${refs.join(',')})`
          return `${expression} AS ${name}`
        })
      return `SELECT id, ${values.join(',')} FROM ${table} s ${index ? `WHERE NOT EXISTS (SELECT 1 FROM ${sessions[0]} newer WHERE newer.id = s.id)` : ''}`
    }).join(' UNION ALL ')
    if (!relation) return { file, reset: true, checkpoint: null, events }
    const messageTables = ['session_message', 'message'].filter((table) => tables.has(table))
    const seen = new Set<string>()
    const covered = new Set<string>()
    for (const table of messageTables) {
      const cols = columns(table)
      if (!cols.has('data') || !cols.has('session_id')) continue
      const rows = db.prepare(`SELECT m.id, m.session_id AS session, m.time_created AS at, m.data, s.directory AS cwd, s.model
        FROM ${table} m JOIN (${relation}) s ON s.id = m.session_id`).iterate()
      for (const raw of rows) {
        const row = OpenRow.safeParse(raw)
        if (!row.success || seen.has(row.data.id)) continue
        let value: unknown
        try { value = JSON.parse(row.data.data) } catch { continue }
        const parsed = OpenMessage.safeParse(value)
        if (!parsed.success || (parsed.data.role && parsed.data.role !== 'assistant') || !parsed.data.tokens) continue
        const data = parsed.data, tokens = data.tokens
        if (!tokens) continue
        seen.add(row.data.id)
        covered.add(row.data.session)
        let modelValue: unknown = data.model ?? row.data.model
        if (typeof modelValue === 'string') { try { modelValue = JSON.parse(modelValue) } catch { modelValue = null } }
        const named = z.object({ modelID: z.string().optional(), id: z.string().optional(), providerID: z.string().optional() }).safeParse(modelValue).data
        const model = data.modelID ?? data.modelId ?? named?.modelID ?? named?.id ?? null
        const provider = data.providerID ?? data.providerId ?? named?.providerID
        events.push(usageEvent('opencode', row.data.id, row.data.at, { session: row.data.session, cwd: row.data.cwd, model: model ? `${provider ? `${provider}/` : ''}${model}` : null, turn: null }, {
          input: tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0), output: tokens.output,
          cacheRead: tokens.cache?.read ?? null, cacheWrite: tokens.cache?.write ?? null, cacheWrite1h: null, costUsd: data.cost ?? null
        }))
      }
    }
    // Session-only stores cannot truthfully split a session's history by day or model.
    for (const raw of db.prepare(`SELECT * FROM (${relation})`).iterate()) {
      if (covered.has(String(raw.id))) continue
      const input = Number(raw.tokens_input ?? 0), output = Number(raw.tokens_output ?? 0)
      if (input + output <= 0) continue
      const at = Number(raw.time_updated ?? raw.time_created)
      if (!Number.isFinite(at) || at <= 0) continue
      events.push(usageEvent('opencode', `session:${String(raw.id)}`, at, {
        session: String(raw.id), cwd: typeof raw.directory === 'string' ? raw.directory : null, model: null, turn: null
      }, { input: input + Number(raw.tokens_cache_read ?? 0) + Number(raw.tokens_cache_write ?? 0), output,
        cacheRead: Number(raw.tokens_cache_read ?? 0), cacheWrite: Number(raw.tokens_cache_write ?? 0),
        costUsd: typeof raw.cost === 'number' ? raw.cost : null }, { precision: 'session' }))
    }
    return { file, reset: true, checkpoint: null, events }
  } finally { db.close() }
}

export async function scanUsageFiles(request: ScanRequest, emit: (file: ScanFile) => void): Promise<{ files: number; errors: string[] }> {
  const seen = new Set<string>(), errors: string[] = []
  let files = 0
  for (const root of request.roots) {
    const folders = root.agent === 'claude' ? ['projects', 'transcripts'] : ['sessions', 'archived_sessions']
    for (const folder of folders) for (const candidate of await findFiles(path.join(root.home, folder), 8, (name) => /\.jsonl(?:\.zst)?$/.test(name))) {
      const file = await realpath(candidate.file).catch(() => candidate.file)
      if (seen.has(file)) continue
      seen.add(file); files++
      try { const result = await scanJsonl(file, root.agent, request.checkpoints[file]); if (result) emit(result) }
      catch { errors.push(`${root.agent}: ${path.basename(file)}`) }
    }
  }
  for (const file of request.opencode) {
    let info
    try { info = await stat(file) } catch { continue }
    files++
    try {
      const wal = await stat(`${file}-wal`).catch(() => null)
      const fileId = `${info.dev}/${info.ino}/${wal?.size ?? 0}/${wal?.mtimeMs ?? 0}`
      const previous = request.checkpoints[file]
      if (previous?.size === info.size && previous.mtime === info.mtimeMs && previous.fileId === fileId) continue
      const result = scanOpenCode(file)
      emit({ ...result, checkpoint: { fileId, size: info.size, mtime: info.mtimeMs, offset: 0, head: '', boundary: '', state: emptyParser(), skipping: false } })
    } catch { errors.push(`opencode: ${path.basename(file)}`) }
  }
  return { files, errors: errors.slice(0, 20) }
}
