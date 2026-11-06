import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { NativeSessions } from '../../native-session'
import { Rejection } from '../../rejection'
import { geminiHome } from './gemini-home'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function geminiSessions(home = geminiHome): NativeSessions {
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? home()) }),
    resolve: async ({ providerSessionId: id, cwd, home: selected }) => {
      if (!ID.test(id)) throw new Rejection('native-session-id-invalid', 'Gemini 会话标识无效')
      const directory = path.resolve(selected ?? home())
      const root = await realpath(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return directory; throw error })
      return { id, root, locator: directory, cwd }
    },
    children: async () => [],
    remove: async (session, executor) => {
      if (!ID.test(session.id) || path.basename(session.locator) !== '.gemini') throw new Rejection('native-session-id-invalid')
      const resolved = await realpath(session.locator).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return session.locator; throw error })
      if (resolved !== session.root) throw new Rejection('native-session-path-invalid', 'Gemini 会话存储位置已改变')
      try {
        // The CLI removes the recording and its plans, task trackers and tool outputs together.
        await executor.command({ command: 'gemini', args: ['--delete-session', session.id], env: { GEMINI_CLI_HOME: path.dirname(session.locator) } }, session.cwd)
      } catch (error) {
        if (error instanceof Rejection && error.reason === 'native-session-command-failed' && /(?:session[^\n]*(?:not found|does not exist)|no session[^\n]*found)/i.test(error.message)) return
        throw error
      }
    }
  }
}
