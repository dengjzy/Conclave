import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { CoreEndpoint } from '../rpc'
import { conclavePaths } from './paths'

export async function readCoreEndpoint(home?: string): Promise<CoreEndpoint | null> {
  try {
    const text = await readFile(conclavePaths(home).coreEndpoint, 'utf8')
    const parsed = CoreEndpoint.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// The token grants full control of local agents, so the file is owner-only.
export async function writeCoreEndpoint(endpoint: CoreEndpoint, home?: string): Promise<void> {
  const file = conclavePaths(home).coreEndpoint
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(endpoint), { mode: 0o600 })
  await rename(tmp, file)
}

// Only the core that wrote the file may remove it; a successor may already own it.
export async function removeCoreEndpoint(pid: number, home?: string): Promise<void> {
  const current = await readCoreEndpoint(home)
  if (current?.pid === pid) {
    await rm(conclavePaths(home).coreEndpoint, { force: true })
  }
}
