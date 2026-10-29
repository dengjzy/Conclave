import type { AcpDialect } from '../acp/acp-dialect'
import { z } from 'zod'

const PermissionPrompt = z.looseObject({ toolCall: z.looseObject({ title: z.string(), content: z.array(z.looseObject({ type: z.string(), content: z.looseObject({ type: z.string(), text: z.string().optional() }).optional() })).optional() }), options: z.array(z.looseObject({ optionId: z.string() })) })

export const kimiDialect: AcpDialect = {
  name: 'Kimi Code',
  idPrefix: 'kimi',
  modes: { ask: 'default', plan: 'plan', auto: 'auto', bypass: 'yolo' },
  // Kimi uses title rather than the optional name extension for its tool identifier.
  toolName: (_input, _name, title) => {
    if (title?.startsWith('mcp__')) return title.replace(/^mcp__(.+?)__/, '$1.')
    if (title === 'Agent' || title === 'AgentSwarm') return 'Task'
    return null
  },
  permissionPrompt: (request) => {
    const parsed = PermissionPrompt.safeParse(request).data
    const tool = parsed?.toolCall
    const text = tool?.content?.find((entry) => entry.type === 'content' && entry.content?.type === 'text')?.content?.text
    if (!text) return null
    if (tool?.title === 'AskUserQuestion') return { kind: 'question', text }
    // ExitPlanMode exits to manual permissions, not the CLI's --auto/--yolo modes.
    if (tool?.title === 'ExitPlanMode' && parsed?.options.some((option) => option.optionId.startsWith('plan_'))) return { kind: 'plan', text, runMode: 'ask' }
    return null
  },
  startNote: (options) => options.extraDirs.length ? `此会话还包含以下项目，请按绝对路径访问；命令分别指定各项目的工作目录：\n${options.extraDirs.map((dir) => `- ${dir}`).join('\n')}` : null
}
