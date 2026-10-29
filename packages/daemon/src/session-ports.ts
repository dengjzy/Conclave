import type { HostedPort, PortRef } from '@conclave/protocol'
import { readListeningProcesses, readProcessFolders, readProcessOwners, stopListeningProcess, type ProcessIdentity, type ProcessSnapshot } from './listening-processes'

export type PortSession = { sessionId: string; pid: number; canStopRoot: boolean }

// The session whose process tree a process is in: its closest ancestor that is a session's root.
function sessionOf(identity: ProcessIdentity, processes: ReadonlyMap<number, ProcessIdentity>, roots: ReadonlyMap<number, PortSession>): PortSession | undefined {
  let ancestor: ProcessIdentity | undefined = identity
  const visited = new Set<number>()
  while (ancestor && !visited.has(ancestor.pid)) {
    visited.add(ancestor.pid)
    const owner = roots.get(ancestor.pid)
    if (owner) return owner
    ancestor = processes.get(ancestor.parentPid)
  }
  return undefined
}

// Listening processes no session's tree leads to: the ones whose environment may still say whose
// they are, having left the tree when the shell or agent that started them went.
export function strayListeners(snapshot: ProcessSnapshot, sessions: readonly PortSession[]): number[] {
  const processes = new Map(snapshot.processes.map((each) => [each.pid, each]))
  const roots = new Map(sessions.map((each) => [each.pid, each]))
  return [...new Set(snapshot.listeners.flatMap((listener) => {
    const identity = processes.get(listener.pid)
    return identity && !sessionOf(identity, processes, roots) ? [listener.pid] : []
  }))]
}

// owners: what stray listeners were started under (PROCESS_OWNER_ENV), by pid. A stray one comes
// with no session, and can always be stopped: it is never an agent itself.
export function sessionPorts(snapshot: ProcessSnapshot, sessions: readonly PortSession[], owners: ReadonlyMap<number, string> = new Map()): HostedPort[] {
  const processes = new Map(snapshot.processes.map((each) => [each.pid, each]))
  const roots = new Map(sessions.map((each) => [each.pid, each]))
  const ports: HostedPort[] = []
  const seen = new Set<string>()
  for (const listener of snapshot.listeners) {
    const identity = processes.get(listener.pid)
    if (!identity) continue
    const session = sessionOf(identity, processes, roots)
    const owner = session ? undefined : owners.get(listener.pid)
    if (!session && !owner) continue
    const key = `${listener.pid}/${listener.address}/${listener.port}`
    if (seen.has(key)) continue
    seen.add(key)
    ports.push(session
      ? { ...listener, sessionId: session.sessionId, startedAt: identity.startedAt, command: identity.command, canStop: listener.pid !== session.pid || session.canStopRoot }
      : { ...listener, sessionId: '', startedAt: identity.startedAt, command: identity.command, canStop: true, ...(owner ? { owner } : {}) })
  }
  return ports.sort((a, b) => a.port - b.port || a.pid - b.pid || a.address.localeCompare(b.address))
}

export class SessionPorts {
  constructor(
    private readonly sessions: () => PortSession[],
    private readonly snapshot: () => Promise<ProcessSnapshot> = readListeningProcesses,
    private readonly stopProcess: (identity: ProcessIdentity) => Promise<void> = stopListeningProcess,
    private readonly folders: (pids: readonly number[]) => Promise<Map<number, string>> = readProcessFolders,
    private readonly owners: (pids: readonly number[]) => Promise<Map<number, string>> = readProcessOwners
  ) {}

  private async ports(snapshot: ProcessSnapshot): Promise<HostedPort[]> {
    const sessions = this.sessions()
    return sessionPorts(snapshot, sessions, await this.owners(strayListeners(snapshot, sessions)))
  }

  async list(): Promise<HostedPort[]> {
    const ports = await this.ports(await this.snapshot())
    const folders = await this.folders(ports.map((port) => port.pid))
    return ports.map((port) => ({ ...port, ...(folders.has(port.pid) ? { cwd: folders.get(port.pid) } : {}) }))
  }

  async stop(ref: PortRef): Promise<void> {
    const snapshot = await this.snapshot()
    const port = (await this.ports(snapshot)).find((each) => each.sessionId === ref.sessionId && each.pid === ref.pid && each.startedAt === ref.startedAt && each.port === ref.port && each.address === ref.address)
    if (!port) throw new Error('port-process-changed')
    if (!port.canStop) throw new Error('port-process-protected')
    const identity = snapshot.processes.find((each) => each.pid === port.pid)
    if (!identity) throw new Error('port-process-changed')
    await this.stopProcess(identity)
  }
}
