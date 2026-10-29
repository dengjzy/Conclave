import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// execFile with no console window: core runs detached and owns none, so on Windows each git it
// started would otherwise flash one of its own.
export function execFileAsync(file: string, args: readonly string[], options: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return run(file, args, { ...options, encoding: 'utf8', windowsHide: true })
}
