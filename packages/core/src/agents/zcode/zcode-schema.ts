import { z } from 'zod'

// The part of ZCode Protocol (its app-server over stdio) Conclave reads. ZCode's own schemas are not
// published, and the protocol is its desktop app's: every shape is loose, and a field it drops or
// renames reads as missing rather than failing the frame.

const id = z.union([z.string(), z.number()])

// A request from either side, an answer to one, or a notification: JSON-RPC without the version.
export const Frame = z.looseObject({ id: id.optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.looseObject({ message: z.string().optional() }).optional() })
export type Frame = z.infer<typeof Frame>

// v4/command's envelope, and its answer: whether the command was taken, and what it made.
export const Command = z.looseObject({ commandId: z.string(), sessionId: z.string().nullable().optional(), type: z.string(), payload: z.looseObject({}).catch({}) })
export const CommandAck = z.looseObject({
  status: z.string(),
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  result: z.looseObject({ type: z.string().optional(), sessionId: z.string().optional() }).optional()
})

// A topic frame as it comes over the wire: whole, or one fragment of a frame too large for one line.
export const WireFrame = z.looseObject({
  kind: z.enum(['complete', 'fragment']),
  topic: z.string(),
  logicalFrameId: z.string(),
  frame: z.unknown().optional(),
  fragmentIndex: z.number().optional(),
  fragmentCount: z.number().optional(),
  checksum: z.looseObject({ algorithm: z.string(), value: z.string() }).optional(),
  dataBase64: z.string().optional()
})
export type WireFrame = z.infer<typeof WireFrame>

const Option = z.looseObject({ optionId: z.string(), kind: z.string(), label: z.string().optional(), name: z.string().optional() })

const Usage = z.looseObject({
  contextWindow: z.looseObject({ usedTokens: z.number(), maxTokens: z.number() }).nullish(),
  cumulative: z.looseObject({ inputTokens: z.number().catch(0), outputTokens: z.number().catch(0), cacheReadTokens: z.number().catch(0), cacheWriteTokens: z.number().catch(0) }).optional()
})
export type ZCodeUsage = z.infer<typeof Usage>

export const SessionConfig = z.looseObject({
  provider: z.string().optional(),
  model: z.string().optional(),
  thought: z.string().optional(),
  thoughtLevels: z.array(z.string()).catch([]).optional(),
  mode: z.string().optional(),
  planEnabled: z.boolean().optional()
})
export type SessionConfig = z.infer<typeof SessionConfig>

export const Control = z.looseObject({
  phase: z.string(),
  lastError: z.looseObject({ message: z.string().optional(), code: z.string().optional() }).nullish()
})

export const InputRouting = z.looseObject({ mode: z.string() })

// What a conversation topic's snapshot holds of the session, and what a state.updated patch replaces
// key by key.
export const SessionState = z.looseObject({
  revision: z.number().optional(),
  control: Control.optional(),
  config: SessionConfig.optional(),
  usage: Usage.optional(),
  inputRouting: InputRouting.optional()
})
export type SessionState = z.infer<typeof SessionState>

const base = { rowId: z.number(), turnId: z.string().optional(), createdAt: z.number().optional() }

export const TurnHeaderRow = z.looseObject({
  ...base,
  kind: z.literal('turnHeader'),
  origin: z.string().optional(),
  sourceCommandId: z.string().optional(),
  state: z.string(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  activeMs: z.number().optional(),
  outputTokens: z.number().optional()
})
export const UserInputRow = z.looseObject({
  ...base,
  kind: z.literal('userInput'),
  text: z.string(),
  origin: z.string().optional(),
  guided: z.boolean().optional(),
  sourceCommandId: z.string().optional(),
  clientId: z.string().optional()
})
export const TextRow = z.looseObject({ ...base, kind: z.enum(['assistantText', 'reasoning']), text: z.string(), state: z.string(), model: z.string().optional() })
export const ToolRow = z.looseObject({
  ...base,
  kind: z.literal('toolCall'),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.string(),
  inputText: z.string().catch(''),
  input: z.unknown().optional(),
  output: z.looseObject({ text: z.string().optional(), display: z.looseObject({ kind: z.string().optional(), serverName: z.string().optional(), toolName: z.string().optional() }).optional() }).optional().catch(undefined),
  error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }).optional().catch(undefined),
  backgrounded: z.boolean().optional()
})
export const SubagentRow = z.looseObject({ ...base, kind: z.literal('subagent'), parentToolCallId: z.string().optional(), subagentType: z.string(), status: z.string(), summaryText: z.string().catch('') })
export const MarkerRow = z.looseObject({ ...base, kind: z.literal('timelineMarker'), marker: z.looseObject({ type: z.string() }).optional(), type: z.string().optional() })
export const Row = z.union([TurnHeaderRow, UserInputRow, TextRow, ToolRow, SubagentRow, MarkerRow, z.looseObject({ ...base, kind: z.string() })])
export type Row = z.infer<typeof Row>

export const Snapshot = SessionState.extend({ sessionId: z.string(), rows: z.looseObject({ window: z.array(z.unknown()).catch([]) }).optional() })

// A delta to a topic: a row added or replaced, streamed text added to a row, or session state
// replaced key by key. Others (plugin UI, workflow runs) are ZCode's desktop's own.
export const DeltaOp = z.looseObject({ op: z.string() })
export const RowChange = z.looseObject({ op: z.enum(['row.appended', 'row.upserted']), row: z.unknown() })
export const RowDelta = z.looseObject({ op: z.literal('row.delta'), rowId: z.number(), append: z.string() })
export const StateUpdated = z.looseObject({ op: z.literal('state.updated'), patch: SessionState })

export const TopicFrame = z.looseObject({
  topic: z.string(),
  subscriptionId: z.string().optional(),
  fromSeq: z.number(),
  toSeq: z.number(),
  payload: z.union([
    z.looseObject({ kind: z.literal('snapshot'), snapshot: z.unknown() }),
    z.looseObject({ kind: z.literal('deltas'), deltas: z.array(z.unknown()) })
  ])
})
export type TopicFrame = z.infer<typeof TopicFrame>

// What ZCode asks before a tool runs: its own options, the answer naming one.
export const PermissionRequest = z.looseObject({
  requestId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  reason: z.string().catch(''),
  riskLevel: z.string().optional(),
  input: z.unknown().optional(),
  options: z.array(Option.extend({ name: z.string().catch(''), response: z.looseObject({ decision: z.string(), permissionUpdates: z.array(z.unknown()).optional() }).optional() })).catch([])
})
export type PermissionRequest = z.infer<typeof PermissionRequest>

const Question = z.looseObject({ question: z.string(), header: z.string().catch(''), multiSelect: z.boolean().optional(), options: z.array(z.looseObject({ label: z.string(), value: z.string().optional(), description: z.string().optional() })).catch([]) })

// A question it puts to the user (AskUserQuestion), or its plan to approve (ExitPlanMode).
export const UserInputRequest = z.looseObject({
  requestId: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  prompt: z.string().optional(),
  input: z.unknown().optional(),
  questions: z.array(Question).catch([]),
  schema: z.looseObject({ interaction: z.string().optional() }).optional().catch(undefined)
})
export type UserInputRequest = z.infer<typeof UserInputRequest>

// session/read's settings: the models the session may switch to, and its thinking levels.
export const SessionSettings = z.looseObject({
  model: z.looseObject({
    available: z.array(z.looseObject({
      ref: z.looseObject({ providerId: z.string(), modelId: z.string() }),
      label: z.string().optional(),
      providerLabel: z.string().optional(),
      contextWindow: z.number().optional(),
      reasoning: z.looseObject({ levels: z.array(z.looseObject({ value: z.string() })).catch([]), defaultLevel: z.string().optional() }).optional().catch(undefined),
      properties: z.looseObject({ inputFormat: z.looseObject({ supportsImage: z.boolean().optional() }).optional() }).optional().catch(undefined)
    })).catch([]),
    current: z.looseObject({ providerId: z.string(), modelId: z.string() }).nullish()
  }).optional(),
  thoughtLevel: z.looseObject({ current: z.string().optional() }).optional()
})
export type SessionSettings = z.infer<typeof SessionSettings>
export const SessionRead = z.looseObject({
  settings: SessionSettings.optional(),
  slashCommands: z.array(z.looseObject({ name: z.string(), description: z.string().optional(), inputHint: z.string().optional() })).catch([]).optional()
})

export const StorageState = z.looseObject({ phase: z.string(), error: z.unknown().optional() })
