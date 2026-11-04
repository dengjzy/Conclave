import type { AcpDialect } from '../acp/acp-dialect'
import { z } from 'zod'

const PermissionPrompt = z.looseObject({
  toolCall: z.looseObject({
    title: z.string().optional(),
    name: z.string().optional(),
    content: z.array(z.looseObject({ type: z.string(), content: z.looseObject({ type: z.string(), text: z.string().optional() }).optional() })).optional()
  }).optional(),
  options: z.array(z.looseObject({ optionId: z.string() })).optional()
})

export const grokDialect: AcpDialect = {
  name: 'Grok',
  idPrefix: 'grok',
  modes: { ask: 'default', plan: 'plan', auto: 'auto', bypass: 'bypassPermissions' },
  authMethod: 'grok.com',
  toolName: (_input, name, title) => {
    if (name?.startsWith('mcp__')) return name.replace(/^mcp__(.+?)__/, '$1.')
    if (title?.startsWith('mcp__')) return title.replace(/^mcp__(.+?)__/, '$1.')
    return null
  },
  permissionPrompt: (request) => {
    const parsed = PermissionPrompt.safeParse(request).data
    const tool = parsed?.toolCall
    const text = tool?.content?.find((entry) => entry.type === 'content' && entry.content?.type === 'text')?.content?.text
    if (!text) return null
    if (tool?.title === 'AskUserQuestion' || tool?.name === 'AskUserQuestion') return { kind: 'question', text }
    return null
  },
  startNote: (options) => options.extraDirs.length ? `此会话还包含以下项目，请按绝对路径访问；命令分别指定各项目的工作目录：\n${options.extraDirs.map((dir) => `- ${dir}`).join('\n')}` : null
}
