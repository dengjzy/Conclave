import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
