import { z } from 'zod'
import type { AcpDialect } from '../acp/acp-dialect'

const text = z.string().optional()
const Command = z.looseObject({ CommandLine: text, command_line: text, commandLine: text, Cwd: text, working_dir: text, workingDir: text, cwd: text })

const REPORTING_INSTRUCTION = '工具或命令调用结束后（无论是执行成功、报错，还是主动终止了冗余后台任务），必须在回合结束前用文字向用户总结执行结果、汇报最新发现或说明任务终止的原因，严禁在执行工具后直接静默结束。'

// Google's Antigravity ACP server: standard ACP with its models and thinking levels in the session
// config. Sign-in is its Google login, which opens the browser the first time.
export const antigravityDialect: AcpDialect = {
  name: 'Antigravity',
  idPrefix: 'antigravity',
  modes: { ask: 'default', acceptEdits: 'auto_edit', bypass: 'yolo' },
  authMethod: 'oauth-personal',
  // A command arrives as { command_line, working_dir }: shown as the command any agent runs.
  toolInput: (rawInput) => {
    const input = Command.safeParse(rawInput).data
    const command = input?.CommandLine ?? input?.command_line ?? input?.commandLine
    const cwd = input?.Cwd ?? input?.working_dir ?? input?.workingDir ?? input?.cwd
    return command === undefined ? rawInput : { command, ...(cwd === undefined ? {} : { cwd }) }
  },
  // Its session takes no additional directories.
  startNote: (options) => {
    const extra = options.extraDirs.length ? `此会话还包含以下项目，请按绝对路径访问；命令分别指定各项目的工作目录：\n${options.extraDirs.map((dir) => `- ${dir}`).join('\n')}` : null
    return [extra, REPORTING_INSTRUCTION].filter(Boolean).join('\n\n')
  }
}
