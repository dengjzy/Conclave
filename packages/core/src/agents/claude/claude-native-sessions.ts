import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import path from 'node:path'
import type { NativeSessions } from '../../native-session'
import { missingSessionFile, sessionStorageFiles, sessionStorageRoot, storedSessionPath } from '../../native-session-files'
import { claudeDefaultHome } from './claude-account'

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function removeClaudeIndexEntry(file: string, id: string): Promise<void> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if (missingSessionFile(error)) return
    throw error
  }
  const index = z.looseObject({ entries: z.array(z.looseObject({ sessionId: z.string() })) }).parse(JSON.parse(text))
  const entries = index.entries.filter((entry) => entry.sessionId !== id)
  if (entries.length === index.entries.length) return
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ ...index, entries }), 'utf8')
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

export async function removeClaudeSession(session: { id: string; root: string; locator: string }): Promise<void> {
  if (!SESSION.test(session.id) || path.basename(session.locator) !== `${session.id}.jsonl`) throw new Error('Claude Code 会话定位无效')
  const file = await storedSessionPath(session.root, session.locator)
  if (file) await rm(file, { force: true })
  const directory = await storedSessionPath(session.root, session.locator.slice(0, -'.jsonl'.length))
  if (directory) await rm(directory, { recursive: true, force: true })
  const index = await storedSessionPath(session.root, path.join(path.dirname(session.locator), 'sessions-index.json'))
  if (index) await removeClaudeIndexEntry(index, session.id)
}

export function claudeNativeSessions(home: () => string = claudeDefaultHome): NativeSessions {
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? home()) }),
    resolve: async (target) => {
      if (!SESSION.test(target.providerSessionId)) throw new Error('Claude Code 会话标识无效')
      const root = await sessionStorageRoot(path.join(target.home ?? home(), 'projects'))
      const files = await sessionStorageFiles(root, 1, (name) => name === `${target.providerSessionId}.jsonl`)
      if (!files.length) return null
      if (files.length > 1) throw new Error('Claude Code 会话标识对应多份历史记录')
      const locator = await storedSessionPath(root, files[0]!)
      return locator ? { id: target.providerSessionId, root, locator, cwd: target.cwd } : null
    },
    // Claude's native subagents are contained in the session's own directory.
    children: async () => [],
    remove: removeClaudeSession
  }
}
