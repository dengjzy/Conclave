import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseChatRecord } from './chat-log'
import { ClaudeStream } from './agents/claude/claude-stream'
import { CodexAppServer } from './agents/codex/codex-app-server'
import { parseClaudeQuick, parseCodexQuick, parseCursorQuick } from './model-metering'

const options = { cwd: '/work/repo', extraDirs: [], resume: null }

describe('model metering', () => {
  it('reads Claude canonical models, cache duration and billed cost independently of the selected alias', () => {
    const answer = parseClaudeQuick(JSON.stringify({
      result: '译文', num_turns: 1, total_cost_usd: 0.01,
      usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } },
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 20, outputTokens: 5, cacheCreationInputTokens: 100, cacheReadInputTokens: 200, costUSD: 0.01 } }
    }), 'haiku')
    expect(answer).toMatchObject({ text: '译文', metering: { calls: 1, callsEstimated: false, reportedCostUsd: 0.01, models: [{ model: 'claude-haiku-4-5-20251001', input: 320, output: 5, cacheRead: 200, cacheWrite: 100, cacheWrite1h: 60, requestInputs: [320] }] } })
    expect(parseClaudeQuick('not json', null)).toEqual({ text: '' })
    expect(parseClaudeQuick(JSON.stringify({ result: 'still readable', usage: { input_tokens: -1 } }), null).text).toBe('still readable')
  })

  it('keeps Codex progress separate from token usage and counts cached input as a subset', () => {
    const answer = parseCodexQuick([
      'progress', JSON.stringify({ type: 'item.completed', item: { text: 'ignored' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 5 } })
    ].join('\n'), 'gpt-6-luna')
    expect(answer.metering).toMatchObject({ calls: 1, callsEstimated: true, models: [{ input: 100, output: 10, cacheRead: 80, cacheWrite: 0 }] })
    expect(parseCodexQuick(JSON.stringify({ type: 'turn.failed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } }), 'gpt-6-luna')).toMatchObject({ failed: true, metering: { models: [{ input: 100 }] } })
  })

  it('adds Cursor cache categories to its uncached input and preserves missing usage', () => {
    expect(parseCursorQuick(JSON.stringify({ result: '翻译', usage: { inputTokens: 3, outputTokens: 6, cacheReadTokens: 100, cacheWriteTokens: 20 } }), 'claude-haiku-4-5')).toMatchObject({
      text: '翻译', metering: { models: [{ input: 123, output: 6, cacheRead: 100, cacheWrite: 20, cacheWrite1h: null }] }
    })
    expect(parseCursorQuick(JSON.stringify({ result: '翻译' }), null)).toEqual({ text: '翻译', failed: undefined })
  })

  it('deduplicates Claude message blocks and keeps num_turns with cache detail through log replay', () => {
    const driver = new ClaudeStream('stage', options)
    driver.apply({ dir: 'out', at: 1, ref: 'request', frame: { type: 'user', message: { role: 'user', content: 'hi' } } })
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }
    for (const type of ['thinking', 'text']) driver.apply({ dir: 'in', at: 2, frame: {
      type: 'assistant', parent_tool_use_id: null, message: { id: 'message', model: 'claude-haiku-4-5', usage, content: [{ type, text: 'hello', thinking: 'think' }] }
    } })
    driver.apply({ dir: 'in', at: 3, frame: { type: 'result', subtype: 'success', num_turns: 1, usage } })
    expect(driver.items.list().find((item) => item.kind === 'turn')).toMatchObject({ metering: { calls: 1, models: [{ requestInputs: [110], cacheRead: 100, cacheWrite1h: 0 }] } })
  })

  it('preserves Codex cached counts through sanitized logs and ignores repeated cumulative reports', () => {
    const live = new CodexAppServer('stage', options)
    const replay = new CodexAppServer('stage', options)
    const lines = readFileSync(new URL('./agents/codex/fixtures/codex-session.jsonl', import.meta.url), 'utf8').split('\n')
    for (const line of lines) {
      const record = parseChatRecord(line)
      if (!record) continue
      live.apply(record)
      const logged = record.dir === 'in' ? live.logged(record.frame) : null
      if (record.dir === 'in' && logged === null) continue
      const kept = record.dir === 'in' ? { ...record, frame: logged } : record
      replay.apply(kept)
      if (JSON.stringify(record).includes('thread/tokenUsage/updated')) replay.apply(kept)
    }
    const turns = (driver: CodexAppServer) => driver.items.list().filter((item) => item.kind === 'turn').map((item) => item.metering)
    expect(turns(replay)).toEqual(turns(live))
    expect(turns(live)[0]?.models[0]).toMatchObject({ input: 14938, output: 203, cacheRead: 11008, cacheWrite: 0 })
  })
})
