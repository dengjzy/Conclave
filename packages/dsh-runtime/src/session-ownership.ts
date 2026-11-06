import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { NATIVE_SESSION_LOG_ENV, OwnedNativeSession } from '@conclave/protocol'

// Inherited by DSH launched from a tool, including diagnostics with no prompt.
export function recordSessionOwnership(session: { id: string; cwd?: string }, env: NodeJS.ProcessEnv = process.env): void {
  const file = env[NATIVE_SESSION_LOG_ENV]
  if (!file) return
  const record = OwnedNativeSession.parse({ agent: 'dsh', providerSessionId: session.id, cwd: session.cwd || process.cwd(), home: env.DSH_HOME || path.join(homedir(), '.dsh') })
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}
