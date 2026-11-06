import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dshTranscripts } from './dsh-transcripts'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'conclave-dsh-transcripts-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeZstdFrames(file: string, lines: string[]): void {
  // Compress each line in its own frame to mimic DSH append-only log
  const buffers = lines.map((l) => zstdCompressSync(Buffer.from(`${l}\n`)))
  writeFileSync(file, Buffer.concat(buffers))
}

describe('DeepSeek Harness transcripts', () => {
  it('scans and summarizes DSH sessions from jsonl.zstd files', async () => {
    const sessionDir = path.join(root, '--work-repo--', 'session-12345678-1234-1234-1234-123456789abc')
    mkdirSync(sessionDir, { recursive: true })
    const file = path.join(sessionDir, 'session.v4.jsonl.zstd')

    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-12345678-1234-1234-1234-123456789abc', createdAt: 1000, cwd: '/work/repo' }),
      JSON.stringify({ type: 'session/title', seq: 1, time: 1010, data: { title: '测试标题', source: { kind: 'provider' } } }),
      JSON.stringify({ type: 'user/message', seq: 2, time: 1020, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'ignore plugin prompt' }] } }),
      JSON.stringify({ type: 'user/message', seq: 3, time: 1030, data: { source: { kind: 'user' }, id: 'user-msg-1', content: [{ type: 'text', text: '请重构此函数\n修复边界情况' }] } }),
      JSON.stringify({
        type: 'assistant/message', seq: 4, time: 1040,
        data: {
          message: {
            id: 'asst-msg-1',
            content: [
              { type: 'reasoning', text: 'Thinking about the refactoring...' },
              { type: 'tool-call', id: 'call_1', name: 'bash', arguments: JSON.stringify({ command: 'ls -la', description: 'List workspace' }) },
              { type: 'text', text: 'I will list the workspace.' }
            ]
          }
        }
      }),
      JSON.stringify({
        type: 'tool/result', seq: 5, time: 1050,
        data: {
          message: {
            content: [
              { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'total 0\nfile.txt' }] }
            ]
          }
        }
      })
    ]

    writeZstdFrames(file, lines)

    const source = dshTranscripts(() => root)
    const list = await source.scan()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      sessionId: 'session-12345678-1234-1234-1234-123456789abc',
      cwd: '/work/repo',
      title: '测试标题',
      named: false,
      firstPrompt: '请重构此函数\n修复边界情况',
      startedAt: 1000
    })

    const transcript = await source.read(file)
    expect(transcript.messages).toEqual([
      { at: 1030, role: 'user', text: '请重构此函数\n修复边界情况', ref: 'user-msg-1' },
      { at: 1040, role: 'assistant', text: 'I will list the workspace.', ref: 'asst-msg-1' }
    ])

    expect(transcript.entries).toHaveLength(4)
    expect(transcript.entries[0]).toMatchObject({
      item: { kind: 'user', text: '请重构此函数\n修复边界情况' }
    })
    expect(transcript.entries[1]).toMatchObject({
      item: { kind: 'reasoning', text: 'Thinking about the refactoring...' }
    })
    expect(transcript.entries[2]).toMatchObject({
      item: { kind: 'tool', name: 'bash', title: 'ls -la', output: 'total 0\nfile.txt' }
    })
    expect(transcript.entries[3]).toMatchObject({
      item: { kind: 'assistant', text: 'I will list the workspace.' }
    })

    await source.delete!(file)
    expect(await source.scan()).toHaveLength(0)
  })
})
