import { spawn } from 'node:child_process'
import os from 'node:os'
import { planLaunch, type DaemonParsedParams } from '@conclave/protocol/node'
import type { HostedProcess, ProcessEvents } from './session-host'

const ignore = () => {}

// A shell reports a process killed by a signal as 128 plus the signal's number.
function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal ? 128 + (os.constants.signals[signal] ?? 0) : -1
}

export function startPipe({ command, args, cwd, env }: DaemonParsedParams<'spawnPipe'>, events: ProcessEvents): HostedProcess {
  // Agent argv never goes through a shell: a Windows .cmd shim is read for what it runs.
  const launch = planLaunch(command, args, cwd, { ...process.env, ...env })
  // Its own process group on POSIX, so a kill also reaches what the agent started (a background shell).
  const group = process.platform !== 'win32'
  const child = spawn(launch.file, launch.args, { cwd, env: launch.env, stdio: 'pipe', detached: group, windowsHide: true })
  let exited = false
  const finish = (exitCode: number) => {
    if (!exited) {
      exited = true
      events.exit(exitCode)
    }
  }
  // Decoded as a stream, so a character split across chunks is not garbled.
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', events.output)
  child.stderr.on('data', events.errorOutput)
  // A write racing the exit fails with EPIPE; unhandled, it would take the daemon and every PTY with it.
  child.stdin.on('error', ignore)
  child.stdout.on('error', ignore)
  child.stderr.on('error', ignore)
  // Without a pid the spawn itself failed (EACCES, say), and nothing else will report it.
  child.on('error', () => {
    if (child.pid === undefined) finish(-1)
  })
  // close rather than exit: stdout may still hold the last lines when the process exits.
  child.on('close', (code, signal) => finish(code ?? signalExitCode(signal)))

  return {
    get pid() { return child.exitCode === null && child.signalCode === null ? child.pid : undefined },
    write(data) {
      if (!exited && child.stdin.writable) child.stdin.write(data)
    },
    resize() {},
    kill(force) {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        // Windows has no polite signal to send; /T takes the agent's own children with it.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', ignore)
        return
      }
      try {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        // The group is already gone.
      }
    }
  }
}
