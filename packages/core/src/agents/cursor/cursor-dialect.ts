import { z } from 'zod'
import { cursorProviderError } from '@conclave/protocol'
import type { AcpDialect } from '../acp/acp-dialect'
import { AcpConfig } from '../acp/acp-schema'

const ModelCatalog = z.looseObject({ models: z.array(z.looseObject({ value: z.string(), name: z.string(), configOptions: z.array(AcpConfig).catch([]) })) })
const RawTool = z.looseObject({ tool: z.string().optional(), toolName: z.string().optional(), _toolName: z.string().optional(), providerIdentifier: z.string().optional(), args: z.unknown().optional() })
const SubagentSpawned = z.looseObject({ _meta: z.looseObject({ cursor: z.looseObject({ toolCallId: z.string().optional() }).optional() }).optional() })

// Cursor CLI's ACP: its own model listing (which names reasoning levels), questions, plans and
// subagents, MCP tools named by their server, and transport errors written into the reply.
export const cursorDialect: AcpDialect = {
  name: 'Cursor',
  idPrefix: 'cursor',
  // Conclave's ask is Cursor's Agent mode, readOnly its Ask mode.
  modes: { ask: 'agent', plan: 'plan', readOnly: 'ask' },
  clientMeta: { parameterizedModelPicker: true, subagents: true },
  authMethod: 'cursor_login',
  models: { method: 'cursor/list_available_models', parse: (result) => ModelCatalog.safeParse(result).data?.models ?? null },
  toolName: (rawInput) => {
    const raw = RawTool.safeParse(rawInput).data
    if (raw?.providerIdentifier && raw.toolName) return `${raw.providerIdentifier}.${raw.toolName}`
    // Cursor marks its subagent call only in the input; Conclave knows a subagent as Task.
    if (raw?._toolName === 'task') return 'Task'
    return raw?.toolName ?? raw?.tool ?? null
  },
  // An MCP call's arguments, under the server and tool that name it.
  toolInput: (rawInput) => {
    const raw = RawTool.safeParse(rawInput).data
    return raw?.providerIdentifier && raw.toolName ? raw.args ?? rawInput : rawInput
  },
  subagentCall: (update) => SubagentSpawned.safeParse(update).data?._meta?.cursor?.toolCallId ?? null,
  requests: {
    question: 'cursor/ask_question',
    // Accepting a plan creates an artifact and ends the planning turn: carrying it out takes a
    // prompt of its own, in Agent mode.
    plan: { method: 'cursor/create_plan', runMode: 'ask', runModeLabel: 'Agent', prompt: '已确认上述计划，请在 Agent 模式按计划开始执行。先检查哪些步骤已经完成，避免重复操作。' },
    acknowledged: ['cursor/task']
  },
  providerError: cursorProviderError
}
