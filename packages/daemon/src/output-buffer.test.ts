import { describe, expect, it } from 'vitest'
import { OutputBuffer } from './output-buffer'

describe('OutputBuffer', () => {
  it('appends and snapshots within limit', () => {
    const buf = new OutputBuffer(20)
    buf.append('hello ')
    buf.append('world')
    expect(buf.snapshot().buffer).toBe('hello world')
    expect(buf.endOffset).toBe(11)
  })

  it('drops older chunks when limit is exceeded', () => {
    const buf = new OutputBuffer(10)
    buf.append('12345678')
    buf.append('90abcdef')
    const snap = buf.snapshot()
    expect(snap.buffer.length).toBeLessThanOrEqual(10)
    expect(snap.buffer).toBe('7890abcdef')
  })

  it('avoids cutting in middle of surrogate pair', () => {
    // '👋' is 2 code units: \uD83D \uDC4B
    const buf = new OutputBuffer(3)
    buf.append('a👋')
    // Length is 3 ('a' + 2 units of 👋). If we append 'b', limit 3 would cut 👋 in half without guard.
    buf.append('b')
    const snap = buf.snapshot()
    // Low surrogate should not be stranded at start
    const firstCode = snap.buffer.charCodeAt(0)
    expect(firstCode < 0xdc00 || firstCode > 0xdfff).toBe(true)
  })

  it('extracts metric score, goal reached, and tail lines', () => {
    const buf = new OutputBuffer(1000)
    buf.append('line 1\nline 2\nMETRIC_SCORE=85.5\nline 3\nGOAL_REACHED=true\nfinal line\n')
    const digest = buf.extractDigest(3)
    expect(digest.metricScore).toBe(85.5)
    expect(digest.goalReached).toBe(true)
    expect(digest.tailText).toContain('final line')
  })
})
