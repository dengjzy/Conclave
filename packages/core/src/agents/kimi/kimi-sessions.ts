import { realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { NativeSessions } from '../../native-session'
import { NativeSessionRpcError } from '../../native-session-runner'
import { Rejection } from '../../rejection'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function kimiSessions(home = () => process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')): NativeSessions {
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? home()) }),
    resolve: async ({ providerSessionId: id, cwd, home: selected }) => {
      if (!ID.test(id)) throw new Rejection('native-session-id-invalid', 'Kimi 会话标识无效')
      const directory = path.resolve(selected ?? home())
      const root = await realpath(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return directory; throw error })
      return { id, root, locator: id, cwd }
    },
    // Kimi keeps its child agents in agents/ inside the same native session.
    children: async () => [],
    remove: async (session, executor) => {
      if (!ID.test(session.id) || session.locator !== session.id) throw new Rejection('native-session-id-invalid')
      try {
        await executor.acp({ command: 'kimi', args: ['acp'], env: { KIMI_CODE_HOME: session.root } }, session.cwd, 'session/delete', { sessionId: session.id })
      } catch (error) {
        if (error instanceof NativeSessionRpcError && error.code === -32602 && /^Unknown sessionId(?:\b|:)/i.test(error.message)) return
        throw error
      }
    }
  }
}
