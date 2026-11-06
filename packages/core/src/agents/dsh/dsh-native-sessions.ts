import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { NativeSession, NativeSessions } from '../../native-session'
import { sessionStorageFiles, sessionStorageRoot, storedSessionHeader, storedSessionPath } from '../../native-session-files'

const ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOG = /^session(?:\.v\d+)?\.jsonl(?:\.zstd|\.zst)?$/i

export function dshNativeSessions(home: () => string = () => process.env.DSH_HOME || path.join(homedir(), '.dsh')): NativeSessions {
  const files = (root: string) => sessionStorageFiles(path.join(root, 'sessions'), 2, (name) => LOG.test(name))
  const locate = async (root: string, id: string, cwd: string): Promise<NativeSession | null> => {
    for (const candidate of await files(root)) {
      if (path.basename(path.dirname(candidate)) !== id) continue
      const locator = await storedSessionPath(root, candidate)
      if (!locator) continue
      const header = await storedSessionHeader(locator)
      if (header?.id !== id) throw new Error('DeepSeek Harness 会话文件标识不匹配')
      return { id, root, locator, cwd }
    }
    return null
  }
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? home()) }),
    resolve: async (target) => {
      if (!ID.test(target.providerSessionId)) throw new Error('DeepSeek Harness 会话标识无效')
      return locate(await sessionStorageRoot(target.home ?? home()), target.providerSessionId, target.cwd)
    },
    children: async (session) => {
      const found = new Map<string, NativeSession>()
      for (const candidate of await files(session.root)) {
        const locator = await storedSessionPath(session.root, candidate)
        if (!locator) continue
        const header = await storedSessionHeader(locator)
        if (header?.origin !== 'subagent' || header.parentSession !== session.id || typeof header.id !== 'string') continue
        if (!ID.test(header.id)) throw new Error('DeepSeek Harness 子会话标识无效')
        found.set(header.id, { id: header.id, root: session.root, locator, cwd: typeof header.cwd === 'string' ? header.cwd : session.cwd })
      }
      return [...found.values()]
    },
    remove: async (session) => {
      if (!ID.test(session.id) || !LOG.test(path.basename(session.locator))) throw new Error('DeepSeek Harness 会话定位无效')
      const file = await storedSessionPath(session.root, session.locator)
      if (file && (await storedSessionHeader(file))?.id !== session.id) throw new Error('DeepSeek Harness 会话标识已经改变')
      const directory = await storedSessionPath(session.root, path.dirname(session.locator))
      if (directory) await rm(directory, { recursive: true, force: true })
      const cached = await storedSessionPath(session.root, path.join(session.root, 'storages', 'session_projcache', 'sessions', `${session.id}.json`))
      if (cached) await rm(cached, { force: true })
    }
  }
}
