import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'

async function withDeadline(operation: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds) })]) }
  finally { if (timer) clearTimeout(timer) }
}

export async function startRemoteProcess(options: {
  executable: string
  args: string[]
  directory: string
  logFile: string
  env: NodeJS.ProcessEnv
  onOutput?: (text: string) => void
  onExit: () => void
}): Promise<{ close(): Promise<void> }> {
  const log = createWriteStream(options.logFile, { flags: 'wx', mode: 0o600 })
  await new Promise<void>((resolve, reject) => { log.once('open', () => resolve()); log.once('error', reject) })
  let stopping = false
  let reported = false
  const failed = () => {
    if (stopping || reported) return
    reported = true
    options.onExit()
  }
  log.on('error', failed)
  const child = spawn(options.executable, options.args, { cwd: options.directory, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve) => child.once('close', () => { failed(); resolve() }))
  child.once('error', failed)
  for (const stream of [child.stdout, child.stderr]) {
    stream.pipe(log, { end: false })
    stream.on('data', (chunk: Buffer) => options.onOutput?.(chunk.toString('utf8')))
  }
  let closing: Promise<void> | undefined
  return {
    close() {
      if (closing) return closing
      stopping = true
      closing = (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          await withDeadline(closed, 3_000)
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
            await withDeadline(closed, 1_000)
          }
        }
        for (const stream of [child.stdout, child.stderr]) { stream.unpipe(log); stream.destroy() }
        if (!log.destroyed) await new Promise<void>((resolve) => log.end(resolve))
      })()
      return closing
    },
  }
}
