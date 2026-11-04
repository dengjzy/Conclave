const DAY_MS = 24 * 60 * 60_000
const SWEEP_MS = 60 * 60_000
// Long enough after start for the daemon to hand back the chats it still runs.
const FIRST_SWEEP_MS = 60_000

// Puts away the free conversations idle longer than the user allows (ChatSettings.autoArchiveDays),
// hourly and whenever that changes. Each goes through the usual archive, which refuses one whose
// agent is working or waits on the user; such a one is left for a later sweep.
export class ConversationAutoArchive {
  private timer: ReturnType<typeof setInterval> | undefined
  private first: ReturnType<typeof setTimeout> | undefined
  private sweeping: Promise<number> | null = null

  constructor(
    private readonly days: () => number | null,
    private readonly idleSince: (before: number) => string[],
    private readonly archive: (id: string) => Promise<unknown>,
    private readonly now: () => number = Date.now,
    private readonly maintenance?: (retentionMs: number) => void
  ) {}

  start(): void {
    this.first = setTimeout(() => void this.sweep(), FIRST_SWEEP_MS)
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS)
    this.first.unref()
    this.timer.unref()
  }

  stop(): void {
    clearTimeout(this.first)
    clearInterval(this.timer)
  }

  // How many it put away; one sweep at a time.
  sweep(): Promise<number> {
    this.sweeping ??= this.run().finally(() => { this.sweeping = null })
    return this.sweeping
  }

  private async run(): Promise<number> {
    const days = this.days()
    let archived = 0
    if (days !== null) {
      for (const id of this.idleSince(this.now() - days * DAY_MS)) {
        try {
          await this.archive(id)
          archived++
        } catch {
          // Busy, launching or gone since the query: the next sweep looks again.
        }
      }
    }
    const retentionDays = days ?? 60
    try {
      this.maintenance?.(retentionDays * DAY_MS)
    } catch (error) {
      console.error('[conclave-core] database maintenance failed:', error)
    }
    return archived
  }
}
