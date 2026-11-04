import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { antigravityTranscripts, parseAntigravityWorkspace } from './antigravity-transcripts'

let tempDir: string
let brainDir: string
let dbFile: string

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'conclave-agy-transcripts-'))
  brainDir = path.join(tempDir, 'brain')
  mkdirSync(brainDir, { recursive: true })
  dbFile = path.join(tempDir, 'conversation_summaries.db')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function createSession(sessionId: string, promptText = 'Help me build a feature') {
  const sessionDir = path.join(brainDir, sessionId, '.system_generated', 'logs')
  mkdirSync(sessionDir, { recursive: true })
  const transcriptPath = path.join(sessionDir, 'transcript.jsonl')
  const lines = [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-04T12:00:00Z', content: '<USER_REQUEST>\n' + promptText + '\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-04T12:00:05Z', thinking: 'thinking...', content: 'Sure!' })
  ]
  writeFileSync(transcriptPath, lines.join('\n') + '\n')
}

describe('antigravityTranscripts', () => {
  it('parses workspace URIs from summaries db into actual project cwd', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111'
    createSession(sessionId, 'Fix the bootloader')

    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT,
        project_id TEXT,
        title TEXT
      );
    `)
    db.prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris, project_id, title) VALUES (?, ?, ?, ?)')
      .run(sessionId, JSON.stringify(['file:///home/user/workspace/my-project']), 'proj-1', 'Fix Bootloader')
    db.close()

    const transcripts = antigravityTranscripts(() => brainDir, () => dbFile)
    const scanned = await transcripts.scan()
    expect(scanned).toHaveLength(1)
    expect(scanned[0]?.sessionId).toBe(sessionId)
    expect(scanned[0]?.cwd).toBe('/home/user/workspace/my-project')
    expect(scanned[0]?.title).toBe('Fix Bootloader')
    expect(scanned[0]?.named).toBe(true)
  })

  it('excludes subagent child sessions from scan', async () => {
    const parentId = '44444444-4444-4444-4444-444444444444'
    const childId = '55555555-5555-5555-5555-555555555555'
    createSession(parentId, 'Main session')
    createSession(childId, 'Subagent task')

    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT,
        project_id TEXT,
        title TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER
      );
    `)
    db.prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris, project_id, title, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)')
      .run(parentId, '[]', 'p1', 'Main session', null, 0)
    db.prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris, project_id, title, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)')
      .run(childId, '[]', 'p1', 'Child subagent', parentId, 1)
    db.close()

    const transcripts = antigravityTranscripts(() => brainDir, () => dbFile)
    const scanned = await transcripts.scan()
    expect(scanned.map((s) => s.sessionId)).toEqual([parentId])
  })

  it('cleans leading markdown and URLs when generating fallback title from prompt', async () => {
    const sessionId = '66666666-6666-6666-6666-666666666666'
    createSession(sessionId, '# 1. [https://example.com/repo](https://example.com/repo) 深度分析架构设计')

    const transcripts = antigravityTranscripts(() => brainDir, () => path.join(tempDir, 'empty.db'))
    const scanned = await transcripts.scan()
    expect(scanned).toHaveLength(1)
    expect(scanned[0]?.title).toBe('深度分析架构设计')
  })

  it('falls back to homedir if summaries db has no workspace or is missing', async () => {
    const sessionId = '22222222-2222-2222-2222-222222222222'
    createSession(sessionId, 'Hello world')

    const transcripts = antigravityTranscripts(() => brainDir, () => path.join(tempDir, 'non_existent.db'))
    const scanned = await transcripts.scan()
    expect(scanned).toHaveLength(1)
    expect(scanned[0]?.cwd).toBe(os.homedir())
  })

  it('handles url encoded workspace uris properly', () => {
    expect(parseAntigravityWorkspace('["file:///home/user/workspace/%E5%B7%A5%E4%BD%9C%E5%8F%B0"]')).toBe('/home/user/workspace/工作台')
    expect(parseAntigravityWorkspace('')).toBeNull()
    expect(parseAntigravityWorkspace('[]')).toBeNull()
  })

  it('cleans up brain directory, individual conversation db and summaries db rows on delete', async () => {
    const sessionId = '33333333-3333-3333-3333-333333333333'
    createSession(sessionId, 'Session to delete')

    // Create individual conversation sqlite db in ~/.gemini/antigravity/conversations/
    const convDir = path.join(tempDir, 'conversations')
    mkdirSync(convDir, { recursive: true })
    const singleDbPath = path.join(convDir, `${sessionId}.db`)
    writeFileSync(singleDbPath, 'dummy sqlite db content')

    // Populate conversation_summaries.db
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT,
        project_id TEXT,
        title TEXT
      );
      CREATE TABLE IF NOT EXISTS conversations_fts (
        conversation_id TEXT,
        title TEXT
      );
    `)
    db.prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris, project_id, title) VALUES (?, ?, ?, ?)')
      .run(sessionId, '[]', 'p1', 'To Delete')
    db.prepare('INSERT INTO conversations_fts (conversation_id, title) VALUES (?, ?)')
      .run(sessionId, 'To Delete')
    db.close()

    const transcripts = antigravityTranscripts(() => brainDir, () => dbFile)
    const transcriptFile = path.join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl')
    await transcripts.delete?.(transcriptFile)

    // Verify brain dir deleted
    expect(existsSync(path.join(brainDir, sessionId))).toBe(false)
    // Verify individual db deleted
    expect(existsSync(singleDbPath)).toBe(false)

    // Verify row removed from summaries db
    const checkDb = new DatabaseSync(dbFile, { readOnly: true })
    const row = checkDb.prepare('SELECT count(*) as count FROM conversation_summaries WHERE conversation_id = ?').get(sessionId) as { count: number }
    expect(row.count).toBe(0)
    checkDb.close()
  })
})
