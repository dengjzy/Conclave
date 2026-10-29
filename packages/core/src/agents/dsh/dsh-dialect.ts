import { z } from 'zod'
import { DSH_RUNTIME_VERSION, DSH_MODES } from '@conclave/protocol'
import type { AcpDialect } from '../acp/acp-dialect'
import { AcpConfig } from '../acp/acp-schema'

const Runtime = z.looseObject({ _meta: z.looseObject({ conclaveDshRuntime: z.literal(DSH_RUNTIME_VERSION) }) })
const Models = z.object({ models: z.array(z.object({ value: z.string(), name: z.string(), configOptions: z.array(AcpConfig) })) })
const BUILTINS = new Set(['bash', 'pwsh', 'write', 'edit', 'read', 'read_image', 'grep', 'glob'])

export const dshDialect: AcpDialect = {
  name: 'DeepSeek Harness', idPrefix: 'dsh',
  modes: Object.fromEntries(DSH_MODES.map((mode) => [mode, mode])),
  initializeError: (result) => Runtime.safeParse(result).success ? null : 'DeepSeek Harness 的 Conclave 运行时版本不兼容，请重新安装运行时插件',
  models: { method: '_conclave/models', parse: (result) => Models.safeParse(result).data?.models ?? null },
  toolName: (_input, name) => name && BUILTINS.has(name) ? null : name?.startsWith('mcp__conclave__') ? `conclave.${name.slice('mcp__conclave__'.length)}` : name ?? null,
  requests: {
    question: '_conclave/question',
    plan: { method: '_conclave/plan', approvalTool: 'plan', runMode: 'acceptEdits', runModeLabel: '自动', prompt: '计划已批准，请开始实施。' }
  },
  startNote: (options) => options.extraDirs.length ? `此会话还包含以下项目，请按绝对路径访问；命令分别指定各项目的工作目录：\n${options.extraDirs.map((dir) => `- ${dir}`).join('\n')}` : null
}
