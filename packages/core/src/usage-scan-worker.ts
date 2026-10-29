import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { ScanCheckpoint, scanUsageFiles } from './usage-scan'

const Request = z.object({
  roots: z.array(z.object({ agent: z.enum(['claude', 'codex']), home: z.string() })),
  checkpoints: z.record(z.string(), ScanCheckpoint), opencode: z.array(z.string())
})
try {
  const result = await scanUsageFiles(Request.parse(workerData), (file) => parentPort?.postMessage({ kind: 'file', ...file }))
  parentPort?.postMessage({ kind: 'done', ...result })
} catch (error) { throw new Error(error instanceof Error ? error.message : String(error)) }
