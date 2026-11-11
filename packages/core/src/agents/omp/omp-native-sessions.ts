import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { NativeSessions } from '../../native-session'
import { sessionStorageFiles, sessionStorageRoot, storedSessionHeader, storedSessionPath } from '../../native-session-files'

export function ompSessionsRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR
  const directory = configured?.startsWith('~/') || configured?.startsWith('~\\') ? path.join(home, configured.slice(2)) : configured
  return path.join(directory || path.join(home, '.omp', 'agent'), 'sessions')
}

export function ompNativeSessions(sessionsRoot: () => string = ompSessionsRoot): NativeSessions {
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? sessionsRoot()) }),
    resolve: async (target) => {
      const root = await sessionStorageRoot(target.home ?? sessionsRoot())
      const files = path.isAbsolute(target.providerSessionId)
        ? [target.providerSessionId]
        : await sessionStorageFiles(root, 2, (name) => name.endsWith('.jsonl'))
      const matching = path.isAbsolute(target.providerSessionId)
        ? files
        : files.filter((file) => file.includes(target.providerSessionId))
      const candidates = matching.length > 0 ? matching : files
      for (const candidate of candidates) {
        const locator = await storedSessionPath(root, candidate)
        if (!locator) continue
        const header = await storedSessionHeader(locator)
        if (!header || typeof header.id !== 'string') {
          if (path.isAbsolute(target.providerSessionId) || candidate.includes(target.providerSessionId)) {
            throw new Error('omp 会话文件缺少有效标识')
          }
          continue
        }
        if (path.isAbsolute(target.providerSessionId) || header.id === target.providerSessionId) {
          return { id: header.id, root, locator, cwd: target.cwd }
        }
      }
      return null
    },
    // omp also records parentSession for independent forks, so it cannot prove ownership.
    children: async () => [],
    remove: async (session) => {
      if (!session.locator.endsWith('.jsonl')) throw new Error('omp 会话文件格式无效')
      const file = await storedSessionPath(session.root, session.locator)
      if (file) {
        const header = await storedSessionHeader(file)
        if (header?.id !== session.id) throw new Error('omp 会话标识已经改变')
        await rm(file, { force: true })
      }
      const directory = await storedSessionPath(session.root, session.locator.slice(0, -'.jsonl'.length))
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
}
