import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { NativeSession, NativeSessions } from '../../native-session'
import { Rejection } from '../../rejection'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

async function verify(session: NativeSession): Promise<boolean> {
  const relative = path.relative(session.root, session.locator).split(path.sep)
  if (!ID.test(session.id) || relative.length !== 2 || relative[1] !== session.id || !inside(session.root, session.locator)) throw new Rejection('native-session-path-invalid')
  const workspace = await lstat(path.dirname(session.locator)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  const info = await lstat(session.locator).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!workspace || !info) return false
  if (!workspace.isDirectory() || workspace.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink() || !inside(session.root, await realpath(session.locator))) throw new Rejection('native-session-path-invalid', 'Cursor 会话目录不是可信的本地目录')
  return true
}

// Cursor documents local chats/<workspace-hash>/<chat-uuid>/ as the complete CLI history.
export function cursorSessions(home = () => path.join(os.homedir(), '.cursor', 'chats')): NativeSessions {
  return {
    capture: (target) => ({ ...target, home: path.resolve(target.home ?? home()) }),
    resolve: async ({ providerSessionId: id, cwd, home: selected }) => {
      if (!ID.test(id)) throw new Rejection('native-session-id-invalid', 'Cursor 会话标识无效')
      const directory = path.resolve(selected ?? home())
      const root = await realpath(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (!root) return null
      const matches: NativeSession[] = []
      for (const workspace of await readdir(root, { withFileTypes: true })) {
        if (!workspace.isDirectory() || workspace.isSymbolicLink()) continue
        const session = { id, root, locator: path.join(root, workspace.name, id), cwd }
        if (await verify(session)) matches.push(session)
      }
      if (matches.length > 1) throw new Rejection('native-session-ambiguous', 'Cursor 会话标识对应多个本地目录，未删除')
      return matches[0] ?? null
    },
    // ACP subagent_spawned IDs are collected from the owning conversation's durable wire log.
    children: async () => [],
    remove: async (session) => { if (await verify(session)) await rm(session.locator, { recursive: true }) }
  }
}
