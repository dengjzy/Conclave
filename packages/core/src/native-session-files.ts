import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseLine, readHead } from './agent-transcripts'

export function missingSessionFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

export async function sessionStorageRoot(dir: string): Promise<string> {
  try { return await realpath(dir) } catch (error) {
    if (missingSessionFile(error)) return path.resolve(dir)
    throw error
  }
}

export function insideSessionStorage(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function storedSessionPath(root: string, file: string): Promise<string | null> {
  if (!insideSessionStorage(root, path.resolve(file))) throw new Error('会话记录不在已登记的历史目录内')
  try {
    const resolved = await realpath(file)
    if (!insideSessionStorage(root, resolved)) throw new Error('会话记录的链接超出已登记的历史目录')
    return resolved
  } catch (error) {
    if (missingSessionFile(error)) return null
    throw error
  }
}

export async function sessionStorageFiles(root: string, depth: number, take: (name: string) => boolean, boundary = root): Promise<string[]> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (missingSessionFile(error)) return []
    throw error
  }
  const found: string[] = []
  for (const entry of entries) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory() && depth > 0) found.push(...await sessionStorageFiles(file, depth - 1, take, boundary))
    else if (entry.isFile() && take(entry.name)) found.push(file)
    else if (entry.isSymbolicLink()) {
      const resolved = await storedSessionPath(boundary, file)
      if (!resolved) continue
      const info = await stat(resolved)
      if (info.isDirectory() && depth > 0) found.push(...await sessionStorageFiles(resolved, depth - 1, take, boundary))
      else if (info.isFile() && take(entry.name)) found.push(resolved)
    }
  }
  return found
}

export async function storedSessionExists(file: string): Promise<boolean> {
  try { await stat(file); return true } catch (error) {
    if (missingSessionFile(error)) return false
    throw error
  }
}

export async function storedSessionHeader(file: string, type = 'session'): Promise<Record<string, unknown> | null> {
  // readHead tolerates a damaged tail; opening first keeps access failures observable to cleanup.
  const handle = await open(file, 'r')
  await handle.close()
  let header: Record<string, unknown> | null = null
  await readHead(file, (line) => {
    const parsed = parseLine(line)
    if (parsed && typeof parsed === 'object' && 'type' in parsed && parsed.type === type) {
      header = Object.fromEntries(Object.entries(parsed))
      return false
    }
    return true
  })
  return header
}
