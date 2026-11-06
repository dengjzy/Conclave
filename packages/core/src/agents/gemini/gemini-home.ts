import os from 'node:os'
import path from 'node:path'

export function geminiHome(env = process.env, home = os.homedir()): string {
  return path.join(env.GEMINI_CLI_HOME || home, '.gemini')
}
