import type { AcpDialect } from '../acp/acp-dialect'

// omp's ACP mode named `default` edits files without asking and sends commands through the
// client's permission gate; that is Conclave's acceptEdits. Its `plan` mode is left out: omp
// approves its own plan and leaves plan mode within the same turn.
export const ompDialect: AcpDialect = {
  name: 'omp',
  idPrefix: 'omp',
  modes: { acceptEdits: 'default' },
  authMethod: 'agent',
  toolName: (_input, name, title) => {
    if (name?.startsWith('mcp__')) return name.replace(/^mcp__(.+?)__/, '$1.')
    if (title?.startsWith('mcp__')) return title.replace(/^mcp__(.+?)__/, '$1.')
    return null
  },
  startNote: (options) => options.extraDirs.length ? `此会话还包含以下项目，请按绝对路径访问；命令分别指定各项目的工作目录：\n${options.extraDirs.map((dir) => `- ${dir}`).join('\n')}` : null
}
