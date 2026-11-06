import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { NativeSessions } from '../../native-session'
import { sessionStorageFiles, sessionStorageRoot, storedSessionHeader, storedSessionPath } from '../../native-session-files'
import { piSessionsRoot } from './pi-transcripts'

export function piNativeSessions(sessionsRoot: () => string = piSessionsRoot): NativeSessions {
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? sessionsRoot()) }),
    resolve: async (target) => {
      const root = await sessionStorageRoot(target.home ?? sessionsRoot())
      const files = path.isAbsolute(target.providerSessionId)
        ? [target.providerSessionId]
        : await sessionStorageFiles(root, 2, (name) => name.endsWith('.jsonl'))
      for (const candidate of files) {
        const locator = await storedSessionPath(root, candidate)
        if (!locator) continue
        const header = await storedSessionHeader(locator)
        if (!header || typeof header.id !== 'string') throw new Error('Pi 会话文件缺少有效标识')
        if (path.isAbsolute(target.providerSessionId) || header.id === target.providerSessionId) {
          return { id: header.id, root, locator, cwd: target.cwd }
        }
      }
      return null
    },
    // Pi also records parentSession for independent forks, so it cannot prove ownership.
    children: async () => [],
    remove: async (session) => {
      if (!session.locator.endsWith('.jsonl')) throw new Error('Pi 会话文件格式无效')
      const file = await storedSessionPath(session.root, session.locator)
      if (file) {
        const header = await storedSessionHeader(file)
        if (header?.id !== session.id) throw new Error('Pi 会话标识已经改变')
        await rm(file, { force: true })
      }
      const directory = await storedSessionPath(session.root, session.locator.slice(0, -'.jsonl'.length))
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
}
