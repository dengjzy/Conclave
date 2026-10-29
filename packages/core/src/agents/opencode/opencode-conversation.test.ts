import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AttachmentStore } from '../../attachment-store'
import { ConversationService } from '../../conversation-service'
import { ConversationStore } from '../../conversation-store'
import { fakeChatDaemon } from '../../fake-chat-agent'
import { ProjectRegistry } from '../../project-registry'
import { TaskStore } from '../../task-store'
import { writePrivateJson } from '@conclave/protocol/node'

vi.mock('./opencode-cli', async (original) => ({ ...await original<object>(), requireOpenCode: vi.fn(async () => '/fake/opencode'), opencodeCatalog: vi.fn(async () => null) }))
const Frame = z.looseObject({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), params: z.unknown().optional() })
const configOptions = [{ id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }, { value: 'conclave-auto', name: 'conclave-auto' }, { value: 'plan', name: 'Plan' }, { value: 'conclave-readonly', name: 'conclave-readonly' }] }]
let root: string
let tasks: TaskStore
let store: ConversationStore
let projects: ProjectRegistry
let service: ConversationService
let daemon: ReturnType<typeof fakeChatDaemon>
let sessions: number
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'conclave-opencode-conversation-'))
  const database = path.join(root, 'conclave.db')
  tasks = new TaskStore(database); store = new ConversationStore(database); projects = new ProjectRegistry(database)
  mkdirSync(path.join(root, 'attachments'))
  sessions = 0
  daemon = fakeChatDaemon()
  service = new ConversationService(store, daemon, path.join(root, 'sessions'), () => {}, projects, new AttachmentStore(path.join(root, 'attachments')), (id) => ({ command: 'node', args: ['mcp', '--conversation', id] }))
  daemon.deliver = (event) => {
    if (event.event === 'data') service.handleData(event)
    else if (event.event === 'exit') service.handleExit(event.sessionId, event.exitCode)
    else service.handleStderr(event.sessionId, event.data)
  }
  const request = daemon.request
  daemon.request = async (method, params) => {
    const result = await request(method, params)
    // OpenCode loads Conclave's MCP server from its config, which reports once it has the tools.
    if (method === 'spawnPipe') {
      const { env } = z.object({ env: z.record(z.string(), z.string()) }).parse(params)
      const config = z.object({ mcp: z.object({ servers: z.object({ conclave: z.object({ command: z.array(z.string()) }) }) }) }).parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}'))
      const command = config.mcp.servers.conclave.command
      await writePrivateJson(command[command.indexOf('--ready-file') + 1]!, { ready: true })
    }
    if (method !== 'write') return result
    const write = z.object({ sessionId: z.string(), data: z.string() }).parse(params)
    for (const line of write.data.split('\n').filter(Boolean)) {
      const frame = Frame.parse(JSON.parse(line))
      const reply = (body: unknown) => queueMicrotask(() => daemon.emit(write.sessionId, { id: frame.id, result: body }))
      if (frame.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { additionalDirectories: {}, fork: {} } }, authMethods: [{ id: 'opencode-login' }] })
      else if (frame.method === 'authenticate') reply({})
      else if (frame.method === 'session/new' || frame.method === 'session/fork') reply({ sessionId: `ses_${++sessions}`, configOptions })
      else if (frame.method === 'session/load') reply({ configOptions })
      else if (frame.method === 'session/set_config_option') reply({ configOptions })
      else if (frame.method === 'session/prompt') {
        const prompt = z.object({ sessionId: z.string(), prompt: z.array(z.object({ text: z.string() })) }).parse(frame.params)
        queueMicrotask(() => {
          daemon.emit(write.sessionId, { method: 'session/update', params: { sessionId: prompt.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${prompt.prompt.at(-1)?.text}` } } } })
          daemon.emit(write.sessionId, { id: frame.id, result: { stopReason: 'end_turn' } })
        })
      }
    }
    return result
  }
})

afterEach(() => { projects.close(); store.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })

const opened = (sessionId: string) => daemon.written(sessionId).map((frame) => Frame.parse(frame)).filter((frame) => ['session/new', 'session/load', 'session/fork'].includes(frame.method ?? ''))
const turns = (id: string) => service.chatPage(id).items.filter((item) => item.kind === 'turn')

async function twoTurns(): Promise<string> {
  const created = await service.create('opencode', [])
  await service.send(created.id, 'first'); await settle()
  await service.send(created.id, 'second'); await settle()
  expect(turns(created.id)).toHaveLength(2)
  return created.id
}

it('starts OpenCode with the agents Conclave adds and its MCP server, reporting once listed, in its environment', async () => {
  await service.create('opencode', [])
  const env = z.object({ env: z.record(z.string(), z.string()) }).parse(daemon.spawns[0]).env
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')
  expect(config.agents).toHaveProperty('conclave-readonly')
  expect(config.mcp.servers.conclave).toMatchObject({ codemode: false, command: expect.arrayContaining(['--ready-on-list']) })
})

it('forks its session whole from the latest turn, which then holds all the fork shows', async () => {
  const source = await twoTurns()
  const last = turns(source).at(-1)!
  const forked = await service.fork(source, last.stageId, last.id)
  await settle()
  expect(opened('pipe-2')).toEqual([expect.objectContaining({ method: 'session/fork', params: expect.objectContaining({ sessionId: 'ses_1' }) })])
  expect(service.stages(forked.id).at(-1)?.providerSessionId).toBe('ses_2')
})

it('starts a fork from an earlier turn afresh, with the chat up to it as a handoff', async () => {
  const source = await twoTurns()
  const first = turns(source)[0]!
  await service.fork(source, first.stageId, first.id)
  await settle()
  expect(opened('pipe-2')).toEqual([expect.objectContaining({ method: 'session/new' })])
})

it('starts a fork from before the latest message afresh: the session holds what came after', async () => {
  const source = await twoTurns()
  const said = service.chatPage(source).items.filter((item) => item.kind === 'user').at(-1)!
  await service.fork(source, said.stageId, said.id)
  await settle()
  expect(opened('pipe-2')).toEqual([expect.objectContaining({ method: 'session/new' })])
})
