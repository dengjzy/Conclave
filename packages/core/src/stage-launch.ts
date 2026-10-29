import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { Rejection } from './rejection'

// What an agent's launch writes for one stage that must not outlive its process: a file only that
// process reads, which may hold a secret (ZCode takes a model provider's key only from a file).
// Core keeps it in a folder of the stage's own, readable by the user alone, and removes the folder
// once the stage's process is gone; an adapter only writes there.

export type StageRef = { sessionsRoot: string; conversationId: string; stageId: string }

const execute = promisify(execFile)
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>
const runCommand: CommandRunner = async (file, args) => (await execute(file, [...args], { windowsHide: true, timeout: 10_000 })).stdout

export function launchRoot(sessionsRoot: string, conversationId: string): string {
  return path.join(sessionsRoot, conversationId, 'launch')
}

export function launchDir(stage: StageRef): string {
  return path.join(launchRoot(stage.sessionsRoot, stage.conversationId), stage.stageId)
}

// The folder made, or one already there, kept to the user alone: on POSIX mode 0700 owned by them,
// never a link; on Windows an access list naming only them. One that cannot be made so is refused.
export async function privateDir(dir: string, platform: NodeJS.Platform = process.platform, run: CommandRunner = runCommand): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Rejection('launch-dir-unsafe', `${dir} 不是普通文件夹`)
  if (platform === 'win32') {
    await protectWindowsDir(dir, run)
    return
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Rejection('launch-dir-unsafe', `${dir} 不属于当前用户`)
  // mkdir leaves a folder that was already there as it was.
  await chmod(dir, 0o700)
}

// The account, as `whoami /user /fo csv /nh` prints it: its name and its SID.
export function parseWhoami(printed: string): { name: string; sid: string } | null {
  const match = /^"([^"]+)","(S-1-[\d-]+)"/m.exec(printed.trim())
  return match?.[1] && match[2] ? { name: match[1], sid: match[2] } : null
}

// Whether icacls lists the folder as reachable by that account alone. Each grant is a line naming a
// principal, by name or (unresolved) by SID, then its rights in parentheses; the first line starts
// with the path. A summary line ends the listing.
export function onlyGrantedTo(printed: string, dir: string, account: { name: string; sid: string }): boolean {
  const principals = printed.split(/\r?\n/)
    .map((line) => (line.toLowerCase().startsWith(dir.toLowerCase()) ? line.slice(dir.length) : line).trim())
    .filter((line) => /:\(/.test(line))
    .map((line) => line.slice(0, line.indexOf(':(')).toLowerCase())
  return principals.length > 0 && principals.every((principal) => principal === account.name.toLowerCase() || principal === account.sid.toLowerCase())
}

// Inheritance off, then full control for the user alone, granted to what the folder will hold.
async function protectWindowsDir(dir: string, run: CommandRunner): Promise<void> {
  const account = parseWhoami(await run('whoami', ['/user', '/fo', 'csv', '/nh']).catch(() => ''))
  if (!account) throw new Rejection('launch-dir-unprotected', '读不到当前 Windows 用户，没法把启动文件限定为只有本人可读')
  try {
    await run('icacls', [dir, '/inheritance:r', '/grant:r', `*${account.sid}:(OI)(CI)F`])
    if (onlyGrantedTo(await run('icacls', [dir]), dir, account)) return
  } catch {
    // Reported below: the folder is not known to be the user's alone.
  }
  throw new Rejection('launch-dir-unprotected', `没法把 ${dir} 限定为只有当前用户可读`)
}

// A file of the stage's own, made afresh: one already there is not written over, as a process still
// reading it may be another start's. Left half-written by a failure, it goes.
export async function writePrivateFile(file: string, text: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(file, { force: true })
    throw error
  }
}

export async function removeLaunch(stage: StageRef): Promise<void> {
  await rm(launchDir(stage), { recursive: true, force: true })
}

// A folder not there holds nothing; one that cannot be read fails the look, to be tried again.
function absent(error: unknown): never[] {
  if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return []
  throw error
}

// Every stage folder left on disk, for core to weigh against the processes still running.
export async function launchLeftovers(sessionsRoot: string): Promise<StageRef[]> {
  const conversations = await readdir(sessionsRoot, { withFileTypes: true }).catch(absent)
  const found = await Promise.all(conversations.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const stages = await readdir(launchRoot(sessionsRoot, entry.name), { withFileTypes: true }).catch(absent)
    return stages.filter((stage) => stage.isDirectory()).map((stage) => ({ sessionsRoot, conversationId: entry.name, stageId: stage.name }))
  }))
  return found.flat()
}

// The folders some running process still names in its environment (an agent started with one, or
// a command it runs), as the platform lets core see: on macOS through ps, on Linux through /proc.
// null where it cannot tell (Windows): then only time says the process is gone.
export async function foldersInUse(dirs: readonly string[], platform: NodeJS.Platform = process.platform, run: CommandRunner = runCommand): Promise<Set<string> | null> {
  if (!dirs.length) return new Set()
  let environments: string[]
  if (platform === 'darwin') {
    const printed = await run('ps', ['-E', '-ww', '-ax', '-o', 'command=']).catch(() => null)
    if (printed === null) return null
    environments = printed.split('\n')
  } else if (platform === 'linux') {
    const pids = (await readdir('/proc').catch(() => [])).filter((name) => /^\d+$/.test(name))
    environments = (await Promise.all(pids.map((pid) => readFile(path.join('/proc', pid, 'environ'), 'utf8').catch(() => '')))).filter(Boolean)
  } else {
    return null
  }
  return new Set(dirs.filter((dir) => environments.some((environment) => environment.includes(`=${dir}`))))
}
