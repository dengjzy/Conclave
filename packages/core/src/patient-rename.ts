import { rename } from 'node:fs/promises'

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])

// Moves a folder just written into place. On Windows an antivirus scanner (Defender, among others)
// holds files it has not finished reading, and renaming their folder fails with EPERM or EBUSY
// for a moment; waiting it out is what npm and graceful-fs do. Elsewhere those codes mean what
// they say, so they fail at once.
export async function renameWhenFree(from: string, to: string, platform: NodeJS.Platform = process.platform, waitMs = 10_000): Promise<void> {
  const until = Date.now() + waitMs
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const busy = platform === 'win32' && error instanceof Error && 'code' in error && typeof error.code === 'string' && BUSY.has(error.code)
      if (!busy || Date.now() + delay > until) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
