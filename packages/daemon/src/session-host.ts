import { PROCESS_OWNER_ENV, type AgentKind } from '@conclave/protocol'
import { randomUUID } from 'node:crypto'
import type {
  DaemonEvent,
  DaemonMethod,
  DaemonParsedParams,
  DaemonResult,
  SessionInfo,
  SessionIo
} from '@conclave/protocol/node'
import { OutputBuffer } from './output-buffer'
import { startPipe } from './pipe-session'
import { startPty } from './pty-session'
import type { AwakeBackendStatus } from './awake-service'
import { SessionPorts } from './session-ports'

// Enough for a reattaching UI to repaint recent output; not a full history.
const PTY_SCROLLBACK_CHARS = 512 * 1024
// JSON lines are replayed into core's own log after a restart, so a pipe keeps more of them.
const PIPE_OUTPUT_CHARS = 8 * 1024 * 1024
const PIPE_STDERR_CHARS = 64 * 1024

// A running process as the registry drives it, whether it sits behind a PTY or plain pipes.
export type HostedProcess = {
  pid?: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(force: boolean): void
}

export type ProcessEvents = {
  output(data: string): void
  errorOutput(data: string): void
  exit(exitCode: number): void
}

type Session = {
  id: string
  io: SessionIo
  process: HostedProcess
  output: OutputBuffer
  stderr: OutputBuffer | null
  exitCode: number | null
  agent?: AgentKind
  upgradeId?: string
  owner?: string
  stopReason?: 'cancelled' | 'timed-out'
  timer?: ReturnType<typeof setTimeout>
}

export type DaemonHandlers = {
  [M in DaemonMethod]: (params: DaemonParsedParams<M>) => M extends 'portsList' | 'portsStop' ? Promise<DaemonResult<M>> : DaemonResult<M>
}

const NOT_STARTED: HostedProcess = { write() {}, resize() {}, kill() {} }

type AwakeController = {
  set(active: boolean, leaseMs: number): AwakeBackendStatus
  status(): AwakeBackendStatus
}

const NO_AWAKE: AwakeController = {
  set: () => ({ active: false, supported: false, problem: 'awake service unavailable' }),
  status: () => ({ active: false, supported: false, problem: 'awake service unavailable' })
}

// What the daemon is and how it leaves, for info and retire.
type Lifecycle = { version: string; leave(): void }
const NO_LIFECYCLE: Lifecycle = { version: '0.0.0', leave() {} }

export function createSessionHost(emit: (event: DaemonEvent) => void, awake: AwakeController = NO_AWAKE, lifecycle: Lifecycle = NO_LIFECYCLE): {
  handlers: DaemonHandlers
  killAll(): void
} {
  const sessions = new Map<string, Session>()
  // Set once it has agreed to leave: nothing may start between that answer and its going.
  let retiring = false
  const ports = new SessionPorts(() => [...sessions.values()].flatMap((session) => session.exitCode === null && session.process.pid !== undefined
    ? [{ sessionId: session.id, pid: session.process.pid, canStopRoot: session.io === 'pty' }]
    : []))

  function getSession(sessionId: string): Session {
    const session = sessions.get(sessionId)
    if (!session) {
      throw new Error('session-not-found')
    }
    return session
  }

  function info(session: Session): SessionInfo {
    return {
      sessionId: session.id,
      exited: session.exitCode !== null,
      exitCode: session.exitCode,
      io: session.io,
      ...(session.agent ? { agent: session.agent } : {}),
      ...(session.upgradeId ? { upgradeId: session.upgradeId } : {}),
      ...(session.owner ? { owner: session.owner } : {}),
      ...(session.stopReason ? { stopReason: session.stopReason } : {})
    }
  }

  function track(io: SessionIo, start: (events: ProcessEvents) => HostedProcess, agent?: AgentKind, upgradeId?: string, owner?: string): { sessionId: string } {
    const output = new OutputBuffer(io === 'pty' ? PTY_SCROLLBACK_CHARS : PIPE_OUTPUT_CHARS)
    const stderr = io === 'pipe' ? new OutputBuffer(PIPE_STDERR_CHARS) : null
    const session: Session = { id: randomUUID(), io, process: NOT_STARTED, output, stderr, exitCode: null, agent, upgradeId, owner }
    const sessionId = session.id
    sessions.set(sessionId, session)
    try {
      session.process = start({
        output: (data) => emit({ event: 'data', sessionId, data, offset: output.append(data) }),
        errorOutput: (data) => {
          stderr?.append(data)
          emit({ event: 'stderr', sessionId, data })
        },
        exit: (exitCode) => {
          if (session.timer) clearTimeout(session.timer)
          session.exitCode = exitCode
          emit({ event: 'exit', sessionId, exitCode })
        }
      })
    } catch (error) {
      sessions.delete(sessionId)
      throw error
    }
    if (upgradeId && session.exitCode === null) {
      session.timer = setTimeout(() => stop(session, 'timed-out'), 5 * 60_000)
      session.timer.unref()
    }
    return { sessionId }
  }

  function stop(session: Session, reason: 'cancelled' | 'timed-out'): void {
    if (session.stopReason) return
    session.stopReason = reason
    if (session.timer) clearTimeout(session.timer)
    session.process.kill(false)
    if (session.exitCode !== null) return
    session.timer = setTimeout(() => { if (session.exitCode === null) session.process.kill(true) }, 2000)
    session.timer.unref()
  }

  function guard(agent?: AgentKind): void {
    if (retiring) throw new Error('daemon-retiring')
    if (agent && [...sessions.values()].some((session) => session.exitCode === null && session.upgradeId && session.agent === agent)) throw new Error('agent-cli-maintenance-running')
  }

  const handlers: DaemonHandlers = {
    portsList: () => ports.list(),
    async portsStop(ref) {
      await ports.stop(ref)
      return { ok: true }
    },
    spawnCliUpgrade({ agent, upgradeId, cols, rows, ...launch }) {
      if (retiring) throw new Error('daemon-retiring')
      if ([...sessions.values()].some((session) => session.exitCode === null && session.upgradeId)) throw new Error('agent-cli-maintenance-running')
      if ([...sessions.values()].some((session) => session.exitCode === null && (session.agent === agent || (session.io === 'pipe' && !session.agent)))) throw new Error('agent-cli-active')
      return track('pty', (events) => startPty(launch, cols, rows, events), agent, upgradeId)
    },
    spawn({ cols, rows, ...launch }) {
      guard(launch.agent)
      return track('pty', (events) => startPty(launch, cols, rows, events), launch.agent)
    },
    spawnPipe(launch) {
      if (!launch.agent && [...sessions.values()].some((session) => session.exitCode === null && session.upgradeId)) throw new Error('agent-cli-maintenance-running')
      guard(launch.agent)
      return track('pipe', (events) => startPipe(launch, events), launch.agent, undefined, launch.env[PROCESS_OWNER_ENV])
    },
    write({ sessionId, data }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        session.process.write(data)
      }
      return { ok: true }
    },
    resize({ sessionId, cols, rows }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        session.process.resize(cols, rows)
      }
      return { ok: true }
    },
    kill({ sessionId, force }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        if (session.upgradeId && !force) stop(session, 'cancelled')
        else session.process.kill(force ?? false)
      }
      return { ok: true }
    },
    attach({ sessionId }) {
      const session = getSession(sessionId)
      return {
        ...info(session),
        ...session.output.snapshot(),
        ...(session.stderr ? { stderr: session.stderr.snapshot().buffer } : {})
      }
    },
    list() {
      return { sessions: [...sessions.values()].map(info) }
    },
    release({ sessionId }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        throw new Error('session-running')
      }
      sessions.delete(sessionId)
      return { ok: true }
    },
    awakeSet({ active, leaseMs }) {
      return awake.set(active, leaseMs)
    },
    awakeStatus() {
      return awake.status()
    },
    info() {
      return { version: lifecycle.version, pid: process.pid, features: ['agent-cli-maintenance'] }
    },
    retire() {
      if (retiring) return { retired: true, live: 0, blockers: [] }
      const live = [...sessions.values()].filter((session) => session.exitCode === null)
      if (live.length > 0) return { retired: false, live: live.length, blockers: live.map((session) => ({ sessionId: session.id, ...(session.agent ? { agent: session.agent } : {}) })) }
      retiring = true
      // After the answer has gone out.
      setTimeout(() => lifecycle.leave(), 50)
      return { retired: true, live: 0, blockers: [] }
    }
  }

  return {
    handlers,
    killAll() {
      sessions.forEach((session) => {
        if (session.exitCode === null) {
          session.process.kill(false)
        }
      })
    }
  }
}
