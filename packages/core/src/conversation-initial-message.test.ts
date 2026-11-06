import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentProfile, type ChatReference, type Conversation } from '@conclave/protocol'
import * as adapters from './agents'
import { AttachmentStore } from './attachment-store'
import { ConversationService, type ConversationEvent } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { pngBytes } from './image-fixtures'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'

describe('durable first-message delivery', () => {
  let root: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let attachments: AttachmentStore
  let daemon: ReturnType<typeof fakeChatDaemon>
  let service: ConversationService
  let observe: (event: ConversationEvent) => void

  function serve(): ConversationService {
    const next = new ConversationService(store, daemon, path.join(root, 'sessions'), (event) => observe(event), projects, attachments)
    daemon.deliver = (event) => {
      if (event.event === 'data') next.handleData(event)
      else if (event.event === 'exit') next.handleExit(event.sessionId, event.exitCode)
      else next.handleStderr(event.sessionId, event.data)
    }
    return next
  }

  function initial(id: string) {
    const message = store.get(id)?.initialMessage
    if (!message) throw new Error('expected the accepted first message to be persisted')
    return message
  }

  const waitFor = async (check: () => boolean) => { await expect.poll(check, { timeout: 3000 }).toBe(true) }
  const sentFrames = (text: string) => daemon.writes.filter(({ frame }) => JSON.stringify(frame).includes(text))
  const draft = () => service.create('claude', [], false, { deferStart: true })
  const input = () => ({ ref: randomUUID(), text: 'durable opening message' })

  function answerInit(sessionId: string): void {
    daemon.emit(sessionId, { type: 'control_response', response: { subtype: 'success', request_id: 'conclave-init', response: {} } })
  }

  async function seed(phase: NonNullable<Conversation['initialMessage']>['phase']) {
    const conversation = await draft()
    const message = input()
    const failStart = vi.spyOn(service, 'continue').mockRejectedValueOnce(new Error('agent unavailable'))
    await service.submit(conversation.id, message)
    await waitFor(() => initial(conversation.id).phase === 'failed')
    failStart.mockRestore()
    store.setInitialMessage(conversation.id, { ...initial(conversation.id), phase })
    return { conversation, message }
  }

  async function reopen(): Promise<void> {
    service.closeInitialMessages()
    projects.close()
    store.close()
    const database = path.join(root, 'conclave.db')
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    service = serve()
    await service.reconcile((await daemon.request('list', {})).sessions)
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-first-message-'))
    const database = path.join(root, 'conclave.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    const attachmentPath = path.join(root, 'attachments')
    mkdirSync(attachmentPath)
    attachments = new AttachmentStore(attachmentPath)
    daemon = fakeChatDaemon()
    daemon.reply = () => {}
    observe = () => {}
    service = serve()
  })

  afterEach(async () => {
    service.closeInitialMessages()
    for (const [sessionId, session] of daemon.sessions) if (session.exitCode === null) daemon.exit(sessionId, 0)
    await waitFor(() => service.listAll().every((conversation) => !conversation.starting))
    vi.restoreAllMocks()
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('acknowledges a durable message before the handshake and delivers after the client leaves', async () => {
    daemon.answerInit = false
    const events: ConversationEvent[] = []
    observe = (event) => events.push(event)
    const conversation = await draft()
    const message = input()

    const accepted = await service.submit(conversation.id, message)
    expect(accepted.initialMessage).toMatchObject(message)
    expect(initial(conversation.id)).toMatchObject(message)
    expect(sentFrames(message.text)).toHaveLength(0)
    await waitFor(() => daemon.written('pipe-1').some((frame) => JSON.stringify(frame).includes('conclave-init')))
    expect(service.get(conversation.id).starting).toBe(true)

    observe = () => {}
    const observedBeforeDisconnect = events.length
    answerInit('pipe-1')
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(sentFrames(message.text)).toHaveLength(1)
    expect(service.chatPage(conversation.id).items.filter((item) => item.kind === 'user')).toHaveLength(1)
    expect(events).toHaveLength(observedBeforeDisconnect)
  })

  it('coalesces simultaneous submissions and sent-message retries by ref', async () => {
    const conversation = await draft()
    const message = input()
    await Promise.all(Array.from({ length: 5 }, () => service.submit(conversation.id, message)))
    await waitFor(() => initial(conversation.id).phase === 'sent')
    await service.submit(conversation.id, message)
    expect(daemon.spawns).toHaveLength(1)
    expect(sentFrames(message.text)).toHaveLength(1)
    expect(service.chatPage(conversation.id).items.filter((item) => item.kind === 'user')).toHaveLength(1)
  })

  it('does not replace the accepted message with another ref or different content', async () => {
    daemon.answerInit = false
    const conversation = await draft()
    const message = input()
    await service.submit(conversation.id, message)
    await expect(service.submit(conversation.id, { ...message, ref: randomUUID() })).rejects.toThrow()
    await expect(service.submit(conversation.id, { ...message, text: 'different opening' })).rejects.toThrow()
    expect(initial(conversation.id)).toMatchObject(message)
    await waitFor(() => daemon.written('pipe-1').some((frame) => JSON.stringify(frame).includes('conclave-init')))
    answerInit('pipe-1')
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(sentFrames(message.text)).toHaveLength(1)
    expect(sentFrames('different opening')).toHaveLength(0)
  })

  it('includes images and references in retry identity and retains them for delivery', async () => {
    daemon.answerInit = false
    const conversation = await draft()
    const image = attachments.putSync(pngBytes(1, 1))
    const references: ChatReference[] = [{ start: 0, end: 7, target: { kind: 'file', path: path.join(root, 'note.md'), relative: 'note.md' } }]
    const message = { ...input(), text: 'note.md: inspect this image', images: [image.id], references }
    await service.submit(conversation.id, message)
    await expect(service.submit(conversation.id, { ...message, images: [] })).rejects.toThrow()
    await expect(service.submit(conversation.id, { ...message, references: [] })).rejects.toThrow()
    expect(initial(conversation.id)).toMatchObject({ ...message, images: [{ id: image.id, width: 1, height: 1 }] })
    await waitFor(() => daemon.written('pipe-1').some((frame) => JSON.stringify(frame).includes('conclave-init')))
    answerInit('pipe-1')
    await waitFor(() => initial(conversation.id).phase === 'sent')
    const user = service.chatPage(conversation.id).items.find((item) => item.kind === 'user')
    expect(user).toMatchObject({ text: message.text, references, images: [{ id: image.id }] })
  })

  it('keeps startup failure and the original input until an explicit retry', async () => {
    daemon.answerInit = false
    const conversation = await draft()
    const message = input()
    await service.submit(conversation.id, message)
    await waitFor(() => daemon.written('pipe-1').some((frame) => JSON.stringify(frame).includes('conclave-init')))
    daemon.exit('pipe-1', 1)
    await waitFor(() => initial(conversation.id).phase === 'failed')
    expect(initial(conversation.id)).toMatchObject(message)
    expect(initial(conversation.id).error).toBeTruthy()
    expect((await service.submit(conversation.id, message)).initialMessage?.phase).toBe('failed')
    expect(initial(conversation.id).phase).toBe('failed')
    expect(daemon.spawns).toHaveLength(1)
    expect(sentFrames(message.text)).toHaveLength(0)

    daemon.answerInit = true
    await service.submit(conversation.id, { ...message, retry: true })
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(daemon.spawns).toHaveLength(2)
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it.each(['accepted', 'starting'] as const)('resumes a persisted %s message after core restarts', async (phase) => {
    const { conversation, message } = await seed(phase)
    await reopen()
    expect(initial(conversation.id)).toMatchObject({ ...message, phase })
    service.recoverInitialMessages()
    service.recoverInitialMessages()
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(daemon.spawns).toHaveLength(1)
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it('reattaches a starting process and waits for its handshake before delivering', async () => {
    const { conversation, message } = await seed('starting')
    daemon.answerInit = false
    const stage = store.startStage(conversation.id, 'claude', randomUUID(), 0)
    const { sessionId } = await daemon.request('spawnPipe', { agent: 'claude', command: 'claude', args: [], cwd: conversation.workspacePath, env: {} })
    store.attachStage(stage.id, sessionId)
    store.update(conversation.id, { sessionId })
    await reopen()
    service.recoverInitialMessages()
    await waitFor(() => daemon.written(sessionId).some((frame) => JSON.stringify(frame).includes('conclave-init')))
    expect(daemon.spawns).toHaveLength(1)
    expect(initial(conversation.id).phase).toBe('starting')
    expect(sentFrames(message.text)).toHaveLength(0)
    answerInit(sessionId)
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(daemon.spawns).toHaveLength(1)
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it('awaits adapter readiness exactly once for fresh and recovered processes', async () => {
    let releaseFresh = () => {}
    let releaseRecovered = () => {}
    const freshReady = new Promise<void>((resolve) => { releaseFresh = resolve })
    const recoveredReady = new Promise<void>((resolve) => { releaseRecovered = resolve })
    const ready = vi.fn(() => freshReady)
    const adapterOf = adapters.adapterOf
    vi.spyOn(adapters, 'adapterOf').mockImplementation((agent) => ({
      ...adapterOf(agent),
      launch: { mcp: (server) => server, prepare: async () => ({}), ready }
    }))
    const fresh = await draft()
    const first = { ...input(), text: 'fresh process opening' }
    await service.submit(fresh.id, first)
    await waitFor(() => ready.mock.calls.length === 1)
    expect(sentFrames(first.text)).toHaveLength(0)
    releaseFresh()
    await waitFor(() => initial(fresh.id).phase === 'sent')
    expect(ready).toHaveBeenCalledTimes(1)
    await service.stop(fresh.id)

    const { conversation, message } = await seed('starting')
    const stage = store.startStage(conversation.id, 'claude', randomUUID(), 0)
    const { sessionId } = await daemon.request('spawnPipe', { agent: 'claude', command: 'claude', args: [], cwd: conversation.workspacePath, env: {} })
    store.attachStage(stage.id, sessionId)
    store.update(conversation.id, { sessionId })
    ready.mockImplementationOnce(() => recoveredReady)
    await reopen()
    service.recoverInitialMessages()
    await waitFor(() => ready.mock.calls.length === 2)
    expect(initial(conversation.id).phase).toBe('starting')
    expect(sentFrames(message.text)).toHaveLength(0)
    releaseRecovered()
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(ready).toHaveBeenCalledTimes(2)
    expect(sentFrames(message.text)).toHaveLength(1)
    expect(daemon.spawns).toHaveLength(2)
  })

  it('retires a recovered process whose adapter readiness fails before explicit retry', async () => {
    const { conversation, message } = await seed('starting')
    const stage = store.startStage(conversation.id, 'claude', randomUUID(), 0)
    const { sessionId } = await daemon.request('spawnPipe', { agent: 'claude', command: 'claude', args: [], cwd: conversation.workspacePath, env: {} })
    store.attachStage(stage.id, sessionId)
    store.update(conversation.id, { sessionId })
    const ready = vi.fn(async () => {}).mockRejectedValueOnce(new Error('adapter readiness failed'))
    const adapterOf = adapters.adapterOf
    vi.spyOn(adapters, 'adapterOf').mockImplementation((agent) => ({
      ...adapterOf(agent),
      launch: { mcp: (server) => server, prepare: async () => ({}), ready }
    }))
    await reopen()
    service.recoverInitialMessages()
    await waitFor(() => initial(conversation.id).phase === 'failed')
    expect(initial(conversation.id).error).toContain('adapter readiness failed')
    expect(service.get(conversation.id).sessionId).toBeNull()
    expect(daemon.killed).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId })]))
    expect(daemon.sessions.get(sessionId)?.exitCode).not.toBeNull()
    expect(sentFrames(message.text)).toHaveLength(0)

    await service.submit(conversation.id, { ...message, retry: true })
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(daemon.spawns).toHaveLength(2)
    expect(service.get(conversation.id).sessionId).not.toBe(sessionId)
    expect(ready).toHaveBeenCalledTimes(2)
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it('does not automatically retry a failed message after core restarts', async () => {
    const { conversation, message } = await seed('failed')
    await reopen()
    service.recoverInitialMessages()
    expect(initial(conversation.id).phase).toBe('failed')
    expect(daemon.spawns).toHaveLength(0)
    await service.submit(conversation.id, { ...message, retry: true })
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it('marks a persisted in-flight send uncertain and never blindly resends it', async () => {
    const { conversation, message } = await seed('sending')
    await reopen()
    service.recoverInitialMessages()
    await waitFor(() => initial(conversation.id).phase === 'uncertain')
    const repeated = await Promise.all([
      service.submit(conversation.id, message),
      service.submit(conversation.id, { ...message, retry: true })
    ])
    expect(repeated.every((receipt) => receipt.initialMessage?.phase === 'uncertain')).toBe(true)
    service.recoverInitialMessages()
    expect(initial(conversation.id).phase).toBe('uncertain')
    expect(daemon.spawns).toHaveLength(0)
    expect(sentFrames(message.text)).toHaveLength(0)
  })

  it('treats a daemon write failure after an outgoing record as uncertain', async () => {
    const conversation = await draft()
    const message = input()
    const request = daemon.request
    daemon.request = async (method, params) => {
      if (method === 'write' && 'data' in params && typeof params.data === 'string' && params.data.includes(message.text)) {
        throw new Error('daemon connection lost during write')
      }
      return request(method, params)
    }
    await service.submit(conversation.id, message)
    await waitFor(() => initial(conversation.id).phase === 'uncertain')
    expect(service.chatPage(conversation.id).items.some((item) => item.id === `u:${message.ref}`)).toBe(true)
    expect((await service.submit(conversation.id, { ...message, retry: true })).initialMessage?.phase).toBe('uncertain')
    expect(daemon.spawns).toHaveLength(1)
    expect(sentFrames(message.text)).toHaveLength(0)
  })

  it('keeps sent receipts idempotent across core restarts', async () => {
    const conversation = await draft()
    const message = input()
    await service.submit(conversation.id, message)
    await waitFor(() => initial(conversation.id).phase === 'sent')
    await service.stop(conversation.id)
    await reopen()
    service.recoverInitialMessages()
    await service.submit(conversation.id, message)
    expect(initial(conversation.id).phase).toBe('sent')
    expect(daemon.spawns).toHaveLength(1)
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it('refuses first-message submission once ordinary conversation history exists', async () => {
    const conversation = await service.create('claude', [])
    await service.send(conversation.id, 'an earlier user message')
    await expect(service.submit(conversation.id, input())).rejects.toThrow()
    expect(store.get(conversation.id)?.initialMessage).toBeFalsy()
    expect(sentFrames('durable opening message')).toHaveLength(0)
  })

  it.each(['task', 'routine', 'discussion', 'squad', 'delegate'] as const)('refuses first-message submission to a managed %s conversation', async (kind) => {
    const parent = await draft()
    const id = randomUUID()
    const conversation = store.create('claude', root, [root], id, {},
      kind === 'task' ? { id: 'task-owned', title: 'Task' } : null,
      kind === 'routine' ? { id: randomUUID(), title: 'Routine' } : null,
      kind === 'discussion' ? { id: randomUUID(), title: 'Discussion' } : null)
    if (kind === 'squad') store.setSquad(id, randomUUID(), true)
    if (kind === 'delegate') {
      const profile = AgentProfile.parse({ id: randomUUID(), name: 'Reviewer', agent: 'claude', createdAt: 1, updatedAt: 1, archivedAt: null })
      store.setProfile(id, profile, parent.id, randomUUID())
    }
    await expect(service.submit(conversation.id, input())).rejects.toThrow()
    expect(store.get(conversation.id)?.initialMessage).toBeFalsy()
    expect(daemon.spawns).toHaveLength(0)
  })

  it('accepts the first message of a user-controlled helper', async () => {
    const parent = await draft()
    const helper = await service.create('claude', [], false, { helperOf: parent.id, deferStart: true })
    const message = input()
    await service.submit(helper.id, message)
    await waitFor(() => initial(helper.id).phase === 'sent')
    expect(service.get(helper.id).helperOf).toBe(parent.id)
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it('refuses to archive or delete a parent while its helper has pending input', async () => {
    daemon.answerInit = false
    const parent = await draft()
    const helper = await service.create('claude', [], false, { helperOf: parent.id, deferStart: true })
    const message = input()
    await service.submit(helper.id, message)
    await expect(service.setArchived(parent.id, true)).rejects.toMatchObject({ reason: 'conversation-running' })
    await expect(service.delete(parent.id)).rejects.toMatchObject({ reason: 'conversation-running' })
    expect(service.get(parent.id).archivedAt).toBeNull()
    expect(service.get(helper.id)).toMatchObject({ helperOf: parent.id, initialMessage: { ref: message.ref } })
    expect(daemon.killed).toHaveLength(0)
    await waitFor(() => daemon.written('pipe-1').some((frame) => JSON.stringify(frame).includes('conclave-init')))
    answerInit('pipe-1')
    await waitFor(() => initial(helper.id).phase === 'sent')
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it('refuses a new helper message while its parent is already being archived', async () => {
    const parent = await draft()
    const helper = await service.create('claude', [], false, { helperOf: parent.id, deferStart: true })
    let releaseCleanup = () => {}
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const cleanup = vi.fn(() => cleanupGate)
    service.setCallCleanup(cleanup)
    const archiving = service.setArchived(parent.id, true)
    try {
      await waitFor(() => cleanup.mock.calls.length === 1)
      await expect(service.submit(helper.id, input())).rejects.toMatchObject({ reason: 'conversation-running' })
      expect(store.get(helper.id)?.initialMessage).toBeFalsy()
      expect(daemon.spawns).toHaveLength(0)
    } finally {
      releaseCleanup()
      await archiving
    }
    expect(service.get(parent.id).archivedAt).not.toBeNull()
    expect(store.get(helper.id)).toBeNull()
  })

  it('refuses acceptance while an earlier option change is awaiting its model catalog', async () => {
    const conversation = await draft()
    const message = input()
    let releaseCatalog = () => {}
    const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve })
    const catalog = vi.spyOn(service, 'chatCatalog').mockImplementation(async () => {
      await catalogGate
      return { models: [{ id: 'sonnet', label: 'Sonnet', description: null, efforts: [], isDefault: true }] }
    })
    const changing = service.setOption(conversation.id, 'model', 'sonnet')
    try {
      await waitFor(() => catalog.mock.calls.length === 1)
      await expect(service.submit(conversation.id, message)).rejects.toMatchObject({ reason: 'conversation-running' })
      expect(store.get(conversation.id)?.initialMessage).toBeFalsy()
      expect(daemon.spawns).toHaveLength(0)
    } finally {
      releaseCatalog()
      await changing
    }
    expect(service.get(conversation.id).chatOptions?.model).toBe('sonnet')
    await service.submit(conversation.id, message)
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(daemon.spawns[0]?.args).toEqual(expect.arrayContaining(['--model', 'sonnet']))
    expect(sentFrames(message.text)).toHaveLength(1)
  })

  it('keeps pending input on its original target while rejecting conflicting actions', async () => {
    daemon.answerInit = false
    const conversation = await draft()
    const message = input()
    await service.submit(conversation.id, message)
    const changes = [
      () => service.send(conversation.id, 'another message'),
      () => service.continue(conversation.id),
      () => service.handoff(conversation.id, 'codex', '', true),
      () => service.setOption(conversation.id, 'model', 'sonnet'),
      () => service.setAdditionalProjects(conversation.id, [root]),
      () => service.setArchived(conversation.id, true),
      () => service.delete(conversation.id),
      () => service.stop(conversation.id),
      () => service.interrupt(conversation.id)
    ]
    for (const change of changes) await expect(change()).rejects.toMatchObject({ reason: 'conversation-running' })
    expect(service.get(conversation.id)).toMatchObject({ agent: 'claude', archivedAt: null, initialMessage: { ref: message.ref } })
    expect(daemon.killed).toHaveLength(0)
    await waitFor(() => daemon.written('pipe-1').some((frame) => JSON.stringify(frame).includes('conclave-init')))
    answerInit('pipe-1')
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(sentFrames(message.text)).toHaveLength(1)
    expect(sentFrames('another message')).toHaveLength(0)
  })

  it('does not deliver an accepted message after core starts closing', async () => {
    daemon.answerInit = false
    const conversation = await draft()
    const message = input()
    await service.submit(conversation.id, message)
    await waitFor(() => daemon.written('pipe-1').some((frame) => JSON.stringify(frame).includes('conclave-init')))
    service.closeInitialMessages()
    answerInit('pipe-1')
    await waitFor(() => !service.get(conversation.id).starting)
    expect(sentFrames(message.text)).toHaveLength(0)
    expect(['accepted', 'starting']).toContain(initial(conversation.id).phase)
    await expect(service.submit(conversation.id, { ...message, retry: true })).rejects.toThrow()
  })

  it('retains accepted input when shutdown precedes the worker and resumes after restart', async () => {
    const conversation = await draft()
    const message = input()
    observe = (event) => {
      if (event.type === 'changed' && event.conversation.initialMessage?.phase === 'accepted') service.closeInitialMessages()
    }
    await service.submit(conversation.id, message)
    expect(initial(conversation.id).phase).toBe('accepted')
    expect(daemon.spawns).toHaveLength(0)
    observe = () => {}
    await reopen()
    service.recoverInitialMessages()
    await waitFor(() => initial(conversation.id).phase === 'sent')
    expect(daemon.spawns).toHaveLength(1)
    expect(sentFrames(message.text)).toHaveLength(1)
  })
})
