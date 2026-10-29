import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentKind, ModelMetering } from '@conclave/protocol'
import { agentDescriptor } from '@conclave/protocol'
import type { AgentAccountStore } from './agent-accounts'
import { adapterOf } from './agents'
import type { QuickCommand } from './agents/agent-adapter'
import type { SessionHost } from './daemon-client'

export class WarmupUncertain extends Error {
  constructor() { super('预热结果未确认，本次不会自动重发') }
}

export async function daemonQuick(host: SessionHost, command: QuickCommand, cwd: string): Promise<string> {
  let session: string | null = null, output = '', end = 0, finished = false
  let settle: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => { settle = (code) => { if (!finished) { finished = true; resolve(code) } } })
  const unlisten = host.onEvent((event) => {
    if (event.sessionId !== session) return
    if (event.event === 'data' && event.offset + event.data.length > end) {
      output += event.data.slice(Math.max(0, end - event.offset)); end = event.offset + event.data.length
      if (output.length > 2 * 1024 * 1024) { void host.request('kill', { sessionId: event.sessionId, force: true }); settle(-1) }
    } else if (event.event === 'exit') settle(event.exitCode)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const created = await host.request('spawnPipe', { command: command.command, args: command.args, cwd, env: command.env ?? {} })
    session = created.sessionId
    const attached = await host.request('attach', { sessionId: session })
    const tail = end > attached.endOffset ? output.slice(Math.max(0, attached.endOffset - (end - output.length))) : ''
    output = attached.buffer + tail; end = Math.max(end, attached.endOffset)
    if (attached.exited) settle(attached.exitCode ?? -1)
    timer = setTimeout(() => {
      if (session) void host.request('kill', { sessionId: session, force: true }).catch(() => {})
      settle(-1)
    }, 30_000)
    if (command.stdin !== null && !finished) await host.request('write', { sessionId: session, data: `${command.stdin}\n` })
    if (await exited !== 0) throw new Error('额度预热失败或超时')
    return output
  } catch (error) {
    if (!finished) throw new WarmupUncertain()
    throw error
  } finally {
    clearTimeout(timer); unlisten()
    if (session) {
      if (!finished) await host.request('kill', { sessionId: session, force: true }).catch(() => {})
      await host.request('release', { sessionId: session }).catch(() => {})
    }
  }
}

export async function warmAccount(host: SessionHost, accounts: Pick<AgentAccountStore, 'launch'>, agent: AgentKind, account: string,
  record: (metering: ModelMetering) => void): Promise<void> {
  const adapter = adapterOf(agent), quick = adapter.quick
  if (!quick) throw new Error('该 Agent 不支持额度预热')
  const launch = await accounts.launch(agent, account)
  if (!launch) throw new Error('该 Agent 不支持按账号预热')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'conclave-warmup-'))
  try {
    const file = path.join(dir, 'answer.txt')
    const model = agentDescriptor(agent).quotaAutomation?.model
    if (!model) throw new Error('没有可用于额度预热的轻量模型')
    const command = await quick.command('Reply with exactly OK. Do not use any tools.', model, file)
    const overrides = adapter.warmup ? adapter.warmup.args(await daemonQuick(host, { ...adapter.warmup.probe, env: { ...adapter.warmup.probe.env, ...launch.env } }, dir)) : []
    const boundary = command.args.lastIndexOf('--')
    const guarded = boundary === -1 ? [...command.args, ...overrides] : [...command.args.slice(0, boundary), ...overrides, ...command.args.slice(boundary)]
    const args = command.stdin === null ? guarded : guarded.at(-1) === '-'
      ? [...guarded.slice(0, -1), command.stdin] : [...guarded, '--', command.stdin]
    const printed = await daemonQuick(host, { ...command, args, stdin: null, env: { ...command.env, ...launch.env } }, dir)
    const answer = quick.parse(printed, model)
    if (answer.metering) record(answer.metering)
    const text = command.output === 'file' ? await readFile(file, 'utf8').catch(() => '') : answer.text
    if (answer.failed || !text.trim()) throw new Error('额度预热未收到回答')
  } finally { await rm(dir, { recursive: true, force: true }) }
}
