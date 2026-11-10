// The most recent output of a session, bounded. Chunks stay separate until a snapshot joins them,
// so each write costs its own length rather than the whole buffer's.
export class OutputBuffer {
  private chunks: string[] = []
  private size = 0
  // Characters written over the session's life; offsets count from the first one.
  private total = 0

  constructor(private readonly limit: number) {}

  get endOffset(): number {
    return this.total
  }

  append(data: string): number {
    const offset = this.total
    this.chunks.push(data)
    this.size += data.length
    this.total += data.length
    while (this.size > this.limit) {
      const first = this.chunks[0]!
      let excess = this.size - this.limit
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        // Avoid splitting between a UTF-16 surrogate pair (0xD800..0xDBFF + 0xDC00..0xDFFF).
        const code = first.charCodeAt(excess)
        const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff
        if (isLowSurrogate && first.length > excess + 1) {
          excess += 1
        }
        this.chunks[0] = first.slice(excess)
        this.size -= excess
      }
    }
    return offset
  }

  snapshot(): { buffer: string; bufferStart: number; endOffset: number } {
    const buffer = this.chunks.join('')
    this.chunks = buffer ? [buffer] : []
    return { buffer, bufferStart: this.total - buffer.length, endOffset: this.total }
  }

  /**
   * Extract tail digest and metrics (METRIC_SCORE, GOAL_REACHED) for bounded context in ratchet loops.
   */
  extractDigest(tailLines = 40): { metricScore: number | null; goalReached: boolean; tailText: string } {
    const { buffer } = this.snapshot()
    const lines = buffer.split(/\r?\n/)
    let metricScore: number | null = null
    let goalReached = false
    for (const line of lines) {
      const m = /^METRIC_SCORE=([+-]?\d+(?:\.\d+)?)$/.exec(line.trim())
      if (m?.[1] !== undefined) metricScore = parseFloat(m[1])
      if (line.includes('GOAL_REACHED=true')) goalReached = true
    }
    const tailText = lines.slice(-tailLines).join('\n')
    return { metricScore, goalReached, tailText }
  }
}
