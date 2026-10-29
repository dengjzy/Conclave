import { PassThrough, Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyAcp } from '@deepseek-ai/dsh-acp'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { UserQuestionError, type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { DSH_RUNTIME_VERSION, DSH_MODE_ENV, DshMode } from '@conclave/protocol'
import { z } from 'zod'
import { modes, runtimeConfig, toolRefusal } from './policy'

export const name = 'conclave-acp'
export const inject = ['agents', 'agentDefaultModel', 'llm', 'sessionPersistence', 'sessions', 'permissionPresets', 'planMode', 'tools', 'userQuestions']

const Frame = z.looseObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional(), error: z.unknown().optional() })
type Frame = z.infer<typeof Frame>
const Configs = z.looseObject({ configOptions: z.array(z.unknown()).optional(), sessionId: z.string().optional() })
const Answer = z.object({ outcome: z.object({ outcome: z.string(), answers: z.array(z.object({ questionId: z.string(), selectedOptionIds: z.array(z.string()) })).optional() }) })
const PRESETS = { ask: 'workspace-write', acceptEdits: 'conclave-auto', plan: 'read-only', readOnly: 'read-only', bypass: 'danger-full-access' } as const

export function apply(ctx: Context): void {
  const config = runtimeConfig()
  const available = modes(config)
  let mode = config.lock ?? config.mode
  let serial = 0
  let sessionId: string | null = null
  let prompting = false
  let reviewing = false
  let configOptions: unknown[] = []
  const requests = new Map<string | number, Frame>()
  const questions = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  const totals: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let hasUsage = false
  const input = new PassThrough()
  const output = new PassThrough()
  const incoming = createInterface({ input: process.stdin })
  const outgoing = createInterface({ input: output })
  const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`)
  const reply = (id: string | number | undefined, result: unknown) => write({ jsonrpc: '2.0', id, result })
  const fail = (id: string | number | undefined, error: unknown) => write({ jsonrpc: '2.0', id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } })
  const agent = (): Agent => {
    const found = ctx.agents.list().find((entry) => entry.session.id === sessionId)
    if (!found) throw new Error('Conclave: session is not ready')
    return found
  }
  const modeOption = () => ({ id: 'conclave.permissionMode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: available.map((value) => ({ value, name: value })) })
  const setMode = (value: unknown) => {
    const next = DshMode.parse(value)
    if (!available.includes(next)) throw new Error(`Conclave: mode ${next} is unavailable in this stage`)
    if (prompting && !reviewing) throw new Error('Conclave: wait for the turn to finish before switching mode')
    const current = agent()
    ctx.permissionPresets.set(current.session, PRESETS[next])
    ctx.planMode.set(current, next === 'plan')
    mode = next
    process.env[DSH_MODE_ENV] = mode
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } } })
  }

  ctx.tools.guard((exec) => toolRefusal(mode, exec.name, exec.arguments, config))
  ctx.on('tools/pre-execute', async (exec, next) => {
    const refusal = toolRefusal(mode, exec.name, exec.arguments, config)
    if (refusal) return { kind: 'deny', reason: refusal }
    if (mode === 'ask' && exec.name.startsWith('mcp__') && !config.readTools.includes(exec.name)) return { kind: 'ask', reason: 'Allow this MCP tool?' }
    return next()
  })
  ctx.on('session/event', (session, event) => {
    if (session.header.id !== sessionId || event.type !== 'assistant/message' || !prompting || !event.data.usage) return
    const used = event.data.usage
    hasUsage = true
    totals.inputTokens += used.inputTokens
    totals.outputTokens += used.outputTokens
    totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + (used.cacheReadTokens ?? 0)
    totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + (used.cacheWriteTokens ?? 0)
  })

  ctx.on('user-questions/request', async (request, next): Promise<AskUserQuestionAnswer> => {
    if (request.agent?.session.id !== sessionId) return next()
    const id = `conclave-dsh-question-${++serial}`
    const plan = request.questions.length === 1 ? request.questions[0] : undefined
    const isPlan = plan?.intent?.kind === 'plan-review'
    const answer = new Promise<unknown>((resolve, reject) => { questions.set(id, { resolve, reject }) })
    const abort = () => questions.get(id)?.reject(new UserQuestionError('Conclave: question cancelled', 'ASK_ABORTED'))
    if (request.signal?.aborted) abort()
    else request.signal?.addEventListener('abort', abort, { once: true })
    if (isPlan) reviewing = true
    write({ jsonrpc: '2.0', id, method: isPlan ? '_conclave/plan' : '_conclave/question', params: isPlan ? {
      sessionId, toolCallId: plan.intent?.callId ?? id, plan: plan.detail, name: plan.header
    } : {
      sessionId, toolCallId: request.wait?.callId ?? id,
      questions: request.questions.map((question) => ({ id: question.id, prompt: question.question, allowMultiple: question.multiSelect, options: question.options?.map((option) => ({ id: option.label, label: option.label })) ?? [] }))
    } })
    try {
      const result = Answer.parse(await answer)
      if (isPlan && plan) {
        if (result.outcome.outcome === 'cancelled') throw new UserQuestionError('Conclave: plan review cancelled', 'ASK_CANCELLED')
        return { answers: [{ id: plan.id, selected: [result.outcome.outcome === 'accepted' ? plan.intent?.approve ?? 'Approve' : 'Keep planning'] }] }
      }
      if (result.outcome.outcome !== 'answered') throw new UserQuestionError('Conclave: question cancelled', 'ASK_CANCELLED')
      const answers = result.outcome.answers ?? []
      return { answers: request.questions.map((question) => {
        const selected = answers.find((entry) => entry.questionId === question.id)?.selectedOptionIds ?? []
        const known = new Set(question.options?.map((option) => option.label) ?? [])
        const custom = selected.filter((value) => !known.has(value)).join('\n')
        return { id: question.id, selected: selected.filter((value) => known.has(value)), ...(custom ? { custom } : {}) }
      }) }
    } finally {
      questions.delete(id)
      request.signal?.removeEventListener('abort', abort)
      if (isPlan) reviewing = false
    }
  })

  const catalog = async () => {
    const groups = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
      try {
        return await Promise.all((await ctx.llm.listModels(provider.id)).map(async (model) => {
          const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
          return {
            value: JSON.stringify([provider.id, model.id]), name: `${provider.name}/${model.name}`,
            configOptions: info.reasoning ? [{ id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', currentValue: String(info.reasoning.defaultEffort ?? ''), options: [
              ...(info.reasoning.defaultEffort === undefined ? [{ value: '', name: 'Provider default' }] : []),
              ...info.reasoning.efforts.map((effort) => ({ value: String(effort.id), name: effort.name }))
            ] }] : []
          }
        }))
      } catch { return [] }
    }))
    return { models: groups.flat() }
  }

  async function fromClient(line: string): Promise<void> {
    const frame = Frame.parse(JSON.parse(line))
    if (typeof frame.id === 'string' && !frame.method && questions.has(frame.id)) {
      questions.get(frame.id)?.resolve(frame.result)
      return
    }
    if (frame.method === '_conclave/models') { reply(frame.id, await catalog()); return }
    if (frame.method === 'session/set_mode' || (frame.method === 'session/set_config_option' && frame.params?.configId === 'conclave.permissionMode')) {
      if (frame.params?.sessionId !== sessionId) throw new Error('Conclave: unknown session')
      setMode(frame.params?.modeId ?? frame.params?.value)
      reply(frame.id, { configOptions: [...configOptions, modeOption()] })
      return
    }
    if (frame.method === 'session/new' || frame.method === 'session/resume') {
      if (sessionId) throw new Error('Conclave: one session per agent process')
      // Extra roots are enforced by Conclave's filesystem and shell providers.
      if (frame.params) delete frame.params.additionalDirectories
    }
    if (frame.method === 'session/prompt') {
      if (prompting) throw new Error('Conclave: a prompt is already running')
      prompting = true
      hasUsage = false
      totals.inputTokens = totals.outputTokens = totals.cacheReadTokens = totals.cacheWriteTokens = 0
    }
    if (frame.method && frame.id !== undefined) requests.set(frame.id, frame)
    input.write(`${JSON.stringify(frame)}\n`)
  }

  function fromAgent(line: string): void {
    const frame = Frame.parse(JSON.parse(line))
    const request = frame.id === undefined ? undefined : requests.get(frame.id)
    if (request && frame.id !== undefined) requests.delete(frame.id)
    if (request?.method === 'session/prompt') {
      prompting = false
      if (!frame.error && hasUsage) frame.result = { ...z.record(z.string(), z.unknown()).parse(frame.result), usage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, cachedReadTokens: totals.cacheReadTokens, cachedWriteTokens: totals.cacheWriteTokens } }
    }
    if (frame.error) { write(frame); return }
    if (request?.method === 'initialize') {
      const initialized = z.record(z.string(), z.unknown()).parse(frame.result)
      const capabilities = z.record(z.string(), z.unknown()).parse(initialized.agentCapabilities ?? {})
      const sessions = z.record(z.string(), z.unknown()).parse(capabilities.sessionCapabilities ?? {})
      frame.result = { ...initialized, _meta: { conclaveDshRuntime: DSH_RUNTIME_VERSION }, agentCapabilities: { ...capabilities, sessionCapabilities: { ...sessions, additionalDirectories: {} } } }
    }
    if (request?.method === 'session/new' || request?.method === 'session/resume') {
      const opened = Configs.parse(frame.result)
      sessionId = opened.sessionId ?? z.string().parse(request.params?.sessionId)
      setMode(mode)
    }
    const result = Configs.safeParse(frame.result)
    if (request && sessionId && result.success && result.data.configOptions) {
      configOptions = result.data.configOptions
      frame.result = { ...result.data, configOptions: [...configOptions, modeOption()] }
    }
    if (frame.method === 'session/update' && frame.params) {
      const update = z.record(z.string(), z.unknown()).parse(frame.params.update)
      if (update.sessionUpdate === 'tool_call' && typeof update.title === 'string') {
        const name = update.title
        const rawInput = z.record(z.string(), z.unknown()).safeParse(update.rawInput).data
        const { file_path: file, ...rest } = rawInput ?? {}
        const kind = name === 'bash' || name === 'pwsh' ? 'execute' : name === 'write' || name === 'edit' ? 'edit' : name === 'read' || name === 'read_image' ? 'read' : name === 'glob' || name === 'grep' ? 'search' : update.kind
        frame.params.update = { ...update, name, kind, ...(typeof file === 'string' ? { rawInput: { ...rest, path: file }, locations: [{ path: file }] } : {}) }
      }
      if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
        configOptions = update.configOptions
        frame.params.update = { ...update, configOptions: [...configOptions, modeOption()] }
      }
    }
    write(frame)
  }

  ctx.effect(() => {
    void (async () => {
      for await (const line of incoming) {
        let id: Frame['id']
        try { id = Frame.parse(JSON.parse(line)).id; await fromClient(line) } catch (error) { fail(id, error) }
      }
      input.end()
    })().catch((error) => ctx.logger.error('Conclave input failed: %o', error))
    void (async () => {
      for await (const line of outgoing) {
        try { fromAgent(line) } catch (error) {
          fail(Frame.safeParse(JSON.parse(line)).data?.id, error)
        }
      }
    })().catch((error) => ctx.logger.error('Conclave output failed: %o', error))
    return () => {
      for (const pending of questions.values()) pending.reject(new UserQuestionError('Conclave: runtime closed', 'ASK_ABORTED'))
      questions.clear()
      incoming.close()
      outgoing.close()
      input.end()
      output.end()
    }
  })
  const selection = config.initialModel ?? ctx.agentDefaultModel.currentSelection()
  applyAcp(ctx, { provider: selection.provider, model: selection.model, stream: ndJsonStream(Writable.toWeb(output), Readable.toWeb(input)) })
}
