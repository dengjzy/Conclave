import * as pty from 'node-pty'
import { planLaunch, type DaemonParsedParams } from '@conclave/protocol/node'
import type { HostedProcess, ProcessEvents } from './session-host'

type Launch = Omit<DaemonParsedParams<'spawn'>, 'cols' | 'rows'>

export function startPty({ command, args, cwd, env }: Launch, cols: number, rows: number, events: ProcessEvents): HostedProcess {
  // Looked up first: node-pty on macOS and Linux reports a missing program only as exit code 1.
  const launch = planLaunch(command, args, cwd, { ...process.env, ...env, TERM: 'xterm-256color' })
  // On Windows the ConPTY node-pty ships, which keeps wide characters in a TUI's rows where an
  // older system one garbles them.
  const proc = pty.spawn(launch.file, launch.args, { name: 'xterm-256color', cwd, cols, rows, env: launch.env, useConptyDll: process.platform === 'win32' })
  proc.onData(events.output)
  proc.onExit(({ exitCode }) => events.exit(exitCode))
  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    // node-pty refuses a signal name on Windows, where every kill is forceful anyway.
    kill: (force) => (force && process.platform !== 'win32' ? proc.kill('SIGKILL') : proc.kill())
  }
}
