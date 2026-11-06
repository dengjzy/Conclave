import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCall, createRpcClient, type AgentProfile, type RpcConnection } from '@conclave/protocol'
import { AgentProfileService, delegationSummary } from './agent-profile-service'
import { AgentProfileStore } from './agent-profile-store'
import { TaskStore } from './task-store'
import { ConversationStore } from './conversation-store'
import { ConversationService } from './conversation-service'
import { ProjectRegistry } from './project-registry'
import { AttachmentStore } from './attachment-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { agentToolsOverCore } from './mcp-agent-tools'

const OPENCODE_REPLY = 'OPENCODE_DELEGATE_SMOKE_OK\n\n<conclave-summary>\n结论：委派冒烟测试通过，按要求仅返回指定字符串。\n改动：无。\n验证：未做（本任务禁止使用工具、编辑文件或运行命令）。\n未解决：无。\n</conclave-summary>'
const COMPLETE_SUMMARY = '<conclave-summary>\n结论：发现问题\n改动：无\n验证：测试失败\n未解决：需要修复超时\n</conclave-summary>'

describe('reusable agent roles and delegated work', () => {
  let root: string
  let tasks: TaskStore
  let conversations: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeChatDaemon>
  let chats: ConversationService
  let store: AgentProfileStore
  let profiles: AgentProfileService
  let reviewer: AgentProfile
  let parentId: string
  const waitFor = async (check: () => boolean) => { await expect.poll(check, { timeout: 5000 }).toBe(true) }
  const resultMessages = () => chats.messages(parentId).filter((message) => message.role === 'user' && message.text.startsWith('智能体委派结果（'))
  const deliveredPayload = (callId: string) => {
    const item = chats.chatPage(parentId).items.find((each) => each.id === `u:agent-result:${callId}`)
    if (item?.kind !== 'user') throw new Error(`No delivery for ${callId}`)
    return JSON.parse(item.text.split('\n')[1] ?? '{}')
  }
  const complete = (sessionId: string, text = 'verified the change', failed = false) => {
    daemon.emit(sessionId, { type: 'assistant', uuid: `a-${sessionId}-${daemon.writes.length}`, message: { id: `m-${sessionId}-${daemon.writes.length}`, content: [{ type: 'text', text }] }, parent_tool_use_id: null })
    daemon.emit(sessionId, { type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, result: text, terminal_reason: failed ? 'error' : 'completed', duration_ms: 5 })
  }
  // A command the agent runs on in the background after its turn, as a dev server does.
  const background = (sessionId: string, id: string, command: string) => {
    daemon.emit(sessionId, { type: 'assistant', uuid: `a-${id}`, message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command, run_in_background: true } }] }, parent_tool_use_id: null })
    daemon.emit(sessionId, { type: 'system', subtype: 'task_started', task_id: `task-${id}`, tool_use_id: id, task_type: 'local_bash', is_backgrounded: true })
  }
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conclave-profiles-')))
    const db = path.join(root, 'conclave.db')
    tasks = new TaskStore(db); conversations = new ConversationStore(db); projects = new ProjectRegistry(db)
    daemon = fakeChatDaemon(); daemon.reply = () => {}
    chats = new ConversationService(conversations, daemon, path.join(root, 'sessions'), (event) => {
      if (event.type === 'changed' || event.type === 'chatItems') profiles.tick()
    }, projects, new AttachmentStore(path.join(root, 'attachments')))
    store = new AgentProfileStore(db)
    profiles = new AgentProfileService(store, chats, { profile: () => {}, call: () => {} })
    chats.setSquadGuard((conversation) => profiles.guard(conversation))
    chats.setCallCleanup((id) => profiles.cancelForParent(id))
    chats.setCapacity({ maxConcurrentAgents: 20, agentConcurrency: { claude: 6 } }, () => profiles.tick())
    daemon.deliver = (event) => {
      if (event.event === 'data') chats.handleData(event)
      else if (event.event === 'exit') chats.handleExit(event.sessionId, event.exitCode)
      else chats.handleStderr(event.sessionId, event.data)
    }
    reviewer = profiles.save({ name: 'Reviewer', agent: 'claude', capability: 'readOnly', instructions: 'Find defects with evidence.' })
    const repo = path.join(root, 'project'); mkdirSync(repo)
    parentId = (await chats.create('claude', [repo], false, { permissionMode: 'ask' })).id
  })
  afterEach(async () => {
    await profiles.close(); projects.close(); conversations.close(); tasks.close()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('delegates directly with a temporary snapshot without saving a role', async () => {
    vi.spyOn(chats, 'chatCatalog').mockResolvedValue({ models: [
      { id: 'sonnet', label: 'Sonnet', description: null, efforts: ['low', 'high'], isDefault: true }
    ] })
    const saved = profiles.list()
    const call = await profiles.dispatch(parentId, undefined, 'Review the changed files', 'direct-review', { agent: 'claude', model: 'sonnet', effort: 'high' })
    expect(call).toMatchObject({ temporary: true, readOnly: true, permissionMode: 'ask', profile: { agent: 'claude', model: 'sonnet', effort: 'high', capability: 'readOnly' } })
    expect(profiles.list()).toEqual(saved)
    await waitFor(() => store.call(call.id).state === 'running')
    const child = chats.get(call.conversationId)
    expect(child).toMatchObject({ parentConversationId: parentId, workspaceReadOnly: true, profile: { id: call.profile.id } })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'high']))
    complete(child.sessionId!, 'Reviewed with evidence')
    await waitFor(() => store.call(call.id).delivered)
    expect(store.call(call.id)).toMatchObject({ state: 'completed', result: 'Reviewed with evidence', temporary: true })
    expect(profiles.list()).toEqual(saved)
  })

  it('deduplicates direct requests by normalized target instead of random snapshot id', async () => {
    await chats.send(parentId, 'Working')
    const call = await profiles.dispatch(parentId, undefined, 'Review', 'direct-ref', { agent: 'claude' })
    const retry = await profiles.dispatch(parentId, undefined, ' Review ', 'direct-ref', { agent: 'claude', model: null, effort: null, capability: 'readOnly' })
    expect(retry.id).toBe(call.id)
    expect(profiles.calls(parentId)).toHaveLength(1)
    await expect(profiles.dispatch(parentId, undefined, 'Review', 'direct-ref', { agent: 'claude', capability: 'develop' })).rejects.toMatchObject({ reason: 'invalid-params' })
    await expect(profiles.dispatch(parentId, undefined, 'Review', 'direct-ref', { agent: 'claude', model: 'sonnet' })).rejects.toMatchObject({ reason: 'invalid-params' })
    await expect(profiles.dispatch(parentId, undefined, 'Another task', 'direct-ref', { agent: 'claude' })).rejects.toMatchObject({ reason: 'invalid-params' })
    await expect(profiles.dispatch(parentId, reviewer.id, 'Review', 'direct-ref')).rejects.toMatchObject({ reason: 'invalid-params' })
    await expect(profiles.dispatch(parentId, reviewer.id, 'Review', undefined, { agent: 'claude' })).rejects.toMatchObject({ reason: 'invalid-params' })
  })

  it('caps a direct developer to its parent permissions and cannot bypass role allowlists', async () => {
    conversations.setWorkspaceReadOnly(parentId, true)
    const call = await profiles.dispatch(parentId, undefined, 'Analyze', undefined, { agent: 'claude', capability: 'develop' })
    expect(call).toMatchObject({ readOnly: true, permissionMode: 'ask' })
    await waitFor(() => store.call(call.id).state === 'running')
    await expect(profiles.dispatch(call.conversationId, undefined, 'Nested', undefined, { agent: 'claude' })).rejects.toMatchObject({ reason: 'agent-call-unavailable' })
    conversations.setProfile(parentId, profiles.save({ name: 'Restricted direct calls', agent: 'claude', callableProfiles: [reviewer.id] }))
    await expect(profiles.dispatch(parentId, undefined, 'Bypass role selection', undefined, { agent: 'claude' })).rejects.toMatchObject({ reason: 'agent-call-forbidden' })
    expect(await profiles.dispatch(parentId, reviewer.id, 'Allowed saved role')).toMatchObject({ profile: { id: reviewer.id } })
  })

  it('uses approval-gated development without inheriting the parent bypass setting', async () => {
    conversations.setChatOptions(parentId, { allowBypass: true, permissionMode: 'bypass' })
    const call = await profiles.dispatch(parentId, undefined, 'Implement a change', undefined, { agent: 'claude', capability: 'develop' })
    expect(call).toMatchObject({ readOnly: false, permissionMode: 'ask', temporary: true })
    await waitFor(() => store.call(call.id).state === 'running')
    expect(chats.get(call.conversationId).workspaceReadOnly).toBe(false)
    expect(conversations.chatOptions(call.conversationId).allowBypass).toBe(false)
    expect(conversations.chatOptions(call.conversationId).permissionMode).toBe('ask')
  })

  it('restores queued direct work and can cancel it without creating a reusable role', async () => {
    await chats.send(parentId, 'Working')
    const call = await profiles.dispatch(parentId, undefined, 'Review later', 'resume-direct', { agent: 'claude' })
    await profiles.close()
    store = new AgentProfileStore(path.join(root, 'conclave.db'))
    profiles = new AgentProfileService(store, chats, { profile: () => {}, call: () => {} })
    complete(chats.get(parentId).sessionId!, 'ready')
    await profiles.reconcile()
    await waitFor(() => store.call(call.id).state === 'running')
    expect(store.call(call.id)).toMatchObject({ temporary: true, profile: { id: call.profile.id } })
    await profiles.cancel(parentId, call.id)
    expect(store.call(call.id).state).toBe('cancelled')
    expect(chats.get(call.conversationId).sessionId).toBeNull()
    expect(profiles.list().map((role) => role.id)).toEqual([reviewer.id])
  })

  it.each(['gemini'] as const)('rejects unsupported read-only direct work for %s before queueing', async (agent) => {
    await expect(profiles.dispatch(parentId, undefined, 'Read only', undefined, { agent })).rejects.toMatchObject({ reason: 'read-only-unsupported' })
    conversations.setWorkspaceReadOnly(parentId, true)
    await expect(profiles.dispatch(parentId, undefined, 'Cannot escalate', undefined, { agent, capability: 'develop' })).rejects.toMatchObject({ reason: 'read-only-unsupported' })
    expect(profiles.calls(parentId)).toEqual([])
  })
  it('freezes role configuration, isolates history, hides the child and returns the result once', async () => {
    await chats.send(parentId, 'Implement a feature')
    const call = await profiles.dispatch(parentId, reviewer.id, 'Review the changed files', 'review-1')
    profiles.save({ ...reviewer, instructions: 'New instructions' }, reviewer.id)
    complete(chats.get(parentId).sessionId!, 'delegated')
    await waitFor(() => store.call(call.id).state === 'running')
    const child = chats.get(call.conversationId)
    expect(child).toMatchObject({ parentConversationId: parentId, agentCallId: call.id, workspaceReadOnly: true, profile: { instructions: reviewer.instructions } })
    expect(chats.list().map((item) => item.id)).toEqual([parentId])
    const spawn = daemon.spawns.at(-1)!
    expect(spawn.args.join(' ')).toContain(reviewer.instructions)
    expect(chats.messages(child.id).some((message) => message.text === 'Implement a feature')).toBe(false)
    complete(child.sessionId!, 'Found a missing timeout')
    await waitFor(() => store.call(call.id).delivered)
    expect(store.call(call.id)).toMatchObject({ state: 'completed', result: 'Found a missing timeout' })
    expect(chats.get(child.id).sessionId).toBeNull()
    await profiles.reconcile()
    expect(chats.messages(parentId).filter((message) => message.text.includes('Found a missing timeout'))).toHaveLength(1)
    expect(await profiles.dispatch(parentId, reviewer.id, 'Review the changed files', 'review-1')).toMatchObject({ id: call.id })
  })
  it('returns a member-written summary promptly while keeping the complete result', async () => {
    const first = await profiles.dispatch(parentId, reviewer.id, 'Review one')
    const second = await profiles.dispatch(parentId, reviewer.id, 'Review two')
    await waitFor(() => store.call(first.id).state === 'running' && store.call(second.id).state === 'running')
    const full = `${'Detailed evidence and stack trace\n'.repeat(150)}${COMPLETE_SUMMARY}`
    complete(chats.get(first.conversationId).sessionId!, full)
    await waitFor(() => store.call(first.id).delivered)
    expect(store.call(second.id).state).toBe('running')
    expect(store.call(first.id).result).toBe(full)
    const delivered = chats.messages(parentId).find((message) => message.text.includes(first.id))?.text ?? ''
    expect(delivered).toContain('测试失败')
    expect(delivered).toContain('需要修复超时')
    expect(delivered).toContain('conclave_agent_status')
    expect(delivered).not.toContain('Detailed evidence and stack trace')
    const payload = deliveredPayload(first.id)
    expect(payload).toMatchObject({
      callId: first.id, ref: null, resultKind: 'summary', resultLength: full.length,
      result: '结论：发现问题\n改动：无\n验证：测试失败\n未解决：需要修复超时',
      resultRef: { tool: 'conclave_agent_status', arguments: { callId: first.id } }
    })
    const client = createRpcClient((frame) => {
      const request = JSON.parse(frame)
      expect(request.method).toBe('agentCalls.list')
      expect(request.params.id).toBe(parentId)
      client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: profiles.calls(request.params.id) }))
    })
    const rpc: RpcConnection = { ...client, features: ['agent-profiles'], close: () => {}, closed: new Promise(() => {}) }
    const status = agentToolsOverCore(async (action) => action(rpc), parentId).find((tool) => tool.spec.name === payload.resultRef.tool)!
    const response = await status.run(payload.resultRef.arguments)
    expect(response.isError).toBe(false)
    const retrieved = AgentCall.parse(JSON.parse(response.content[0]?.text ?? 'null'))
    expect(retrieved.id).toBe(first.id)
    expect(retrieved.result).toBe(full)
    expect(retrieved.result).toHaveLength(payload.resultLength)
    expect(retrieved.result).toContain('Detailed evidence and stack trace')
    expect(response.content[0]?.text).not.toContain(second.id)
  })

  it('delivers the exact short OpenCode reply even when its valid summary omits the requested marker', async () => {
    expect(OPENCODE_REPLY).toHaveLength(132)
    const instruction = 'Reply only OPENCODE_DELEGATE_SMOKE_OK.'
    const call = await profiles.dispatch(parentId, reviewer.id, instruction, 'opencode-marker')
    await waitFor(() => store.call(call.id).state === 'running')
    const prompt = chats.messages(call.conversationId).find((message) => message.role === 'user')?.text ?? ''
    expect(prompt).toContain(instruction)
    expect(prompt).not.toContain('摘要必须使用以下格式，每项都填写')

    complete(chats.get(call.conversationId).sessionId!, OPENCODE_REPLY)
    await waitFor(() => store.call(call.id).delivered)
    expect(deliveredPayload(call.id)).toMatchObject({
      callId: call.id, name: reviewer.name, ref: 'opencode-marker', state: 'completed', error: null,
      result: OPENCODE_REPLY, resultKind: 'full', resultLength: 132,
      resultRef: { tool: 'conclave_agent_status', arguments: { callId: call.id } },
      fullResult: expect.stringContaining(call.id)
    })
    expect(store.call(call.id).result).toBe(OPENCODE_REPLY)
  })

  it.each([4000, 4001])('chooses full text or summary at the %i character boundary', async (length) => {
    const call = await profiles.dispatch(parentId, reviewer.id, 'Return the report', `boundary-${length}`)
    await waitFor(() => store.call(call.id).state === 'running')
    const full = `${'x'.repeat(length - COMPLETE_SUMMARY.length - 1)}\n${COMPLETE_SUMMARY}`
    expect(full).toHaveLength(length)
    complete(chats.get(call.conversationId).sessionId!, full)
    await waitFor(() => store.call(call.id).delivered)
    const delivered = deliveredPayload(call.id)
    expect(delivered.resultKind).toBe(length === 4000 ? 'full' : 'summary')
    expect(delivered.result).toBe(length === 4000 ? full : '结论：发现问题\n改动：无\n验证：测试失败\n未解决：需要修复超时')
    expect(delivered.resultLength).toBe(length)
    expect(store.call(call.id).result).toBe(full)
  })

  it('delivers a long report in full when its attached summary is incomplete', async () => {
    const call = await profiles.dispatch(parentId, reviewer.id, 'Review with evidence', 'incomplete-summary')
    await waitFor(() => store.call(call.id).state === 'running')
    const full = `${'Evidence '.repeat(600)}\n${COMPLETE_SUMMARY.replace('未解决：需要修复超时', '未解决：')}`
    complete(chats.get(call.conversationId).sessionId!, full)
    await waitFor(() => store.call(call.id).delivered)
    expect(deliveredPayload(call.id)).toMatchObject({
      callId: call.id, result: full, resultKind: 'full', resultLength: full.length,
      resultRef: { tool: 'conclave_agent_status', arguments: { callId: call.id } }
    })
    expect(store.call(call.id).result).toBe(full)
  })

  it('keeps concurrent results associated with their own calls while the parent handles one at a time', async () => {
    const first = await profiles.dispatch(parentId, reviewer.id, 'First review', 'first-result')
    const second = await profiles.dispatch(parentId, reviewer.id, 'Second review', 'second-result')
    await waitFor(() => store.call(first.id).state === 'running' && store.call(second.id).state === 'running')
    complete(chats.get(first.conversationId).sessionId!, 'FIRST_DELEGATE_SMOKE_OK')
    await waitFor(() => store.call(first.id).delivered)
    const parentSession = chats.get(parentId).sessionId!
    expect(chats.get(parentId).chat?.turn).toBe('running')

    complete(chats.get(second.conversationId).sessionId!, 'SECOND_DELEGATE_SMOKE_OK')
    await waitFor(() => store.call(second.id).state === 'completed')
    expect(store.call(second.id).delivered).toBe(false)
    expect(resultMessages()).toHaveLength(1)
    expect(deliveredPayload(first.id)).toMatchObject({ callId: first.id, ref: 'first-result', result: 'FIRST_DELEGATE_SMOKE_OK', resultKind: 'full' })

    complete(parentSession, 'ACK FIRST_DELEGATE_SMOKE_OK')
    await waitFor(() => store.call(second.id).delivered)
    expect(deliveredPayload(second.id)).toMatchObject({ callId: second.id, ref: 'second-result', result: 'SECOND_DELEGATE_SMOKE_OK', resultKind: 'full' })
    await profiles.reconcile()
    expect(resultMessages()).toHaveLength(2)
    expect(store.call(first.id).result).toBe('FIRST_DELEGATE_SMOKE_OK')
    expect(store.call(second.id).result).toBe('SECOND_DELEGATE_SMOKE_OK')
  })

  it('resumes a stopped parent and does not resend a recorded result after interrupted delivery bookkeeping', async () => {
    const call = await profiles.dispatch(parentId, reviewer.id, 'Read the result', 'restore-result')
    await waitFor(() => store.call(call.id).state === 'running')
    expect(chats.get(parentId).sessionId).toBeNull()
    complete(chats.get(call.conversationId).sessionId!, OPENCODE_REPLY)
    await waitFor(() => store.call(call.id).delivered)
    expect(chats.get(parentId).sessionId).not.toBeNull()
    expect(deliveredPayload(call.id)).toMatchObject({ callId: call.id, ref: 'restore-result', result: OPENCODE_REPLY, resultKind: 'full' })
    complete(chats.get(parentId).sessionId!, 'ACK OPENCODE_DELEGATE_SMOKE_OK')
    await chats.stop(parentId)
    // The parent recorded the message, but core stopped before persisting the delivery flag.
    store.patchCall(call.id, { delivered: false })
    await profiles.close()
    conversations.close()
    const db = path.join(root, 'conclave.db')
    conversations = new ConversationStore(db)
    chats = new ConversationService(conversations, daemon, path.join(root, 'sessions'), (event) => {
      if (event.type === 'changed' || event.type === 'chatItems') profiles.tick()
    }, projects, new AttachmentStore(path.join(root, 'attachments')))
    store = new AgentProfileStore(db)
    profiles = new AgentProfileService(store, chats, { profile: () => {}, call: () => {} })
    chats.setSquadGuard((conversation) => profiles.guard(conversation))
    chats.setCallCleanup((id) => profiles.cancelForParent(id))
    chats.setCapacity({ maxConcurrentAgents: 20, agentConcurrency: { claude: 6 } }, () => profiles.tick())
    daemon.deliver = (event) => {
      if (event.event === 'data') chats.handleData(event)
      else if (event.event === 'exit') chats.handleExit(event.sessionId, event.exitCode)
      else chats.handleStderr(event.sessionId, event.data)
    }
    await profiles.reconcile()
    await profiles.reconcile()
    expect(store.call(call.id)).toMatchObject({ delivered: true, state: 'completed', result: OPENCODE_REPLY })
    expect(resultMessages()).toHaveLength(1)
    expect(daemon.writes.filter(({ frame }) => {
      const text = JSON.stringify(frame)
      return text.includes('智能体委派结果（') && text.includes(call.id)
    })).toHaveLength(1)
    expect(chats.agentIdle(parentId)).toBe(true)
  })

  it('falls back to the whole report when no complete, bounded summary is provided', () => {
    const completeSummary = '<conclave-summary>\n结论：done\n改动：none\n验证：failed\n未解决：failure\n</conclave-summary>'
    expect(delegationSummary(`Evidence\n${completeSummary}`)).toContain('验证：failed')
    expect(delegationSummary('long report with failure at the end')).toBeNull()
    expect(delegationSummary(completeSummary.replace('未解决：failure', '未解决：'))).toBeNull()
    expect(delegationSummary(completeSummary.replace('结论：done', `结论：${'x'.repeat(4001)}`))).toBeNull()
    expect(delegationSummary(`${completeSummary}\nA stopped background process`)).toBeNull()
    expect(delegationSummary(`${completeSummary}\n\n（委派结束时，已停止成员留在后台的命令：pnpm preview）`)).toContain('已停止成员留在后台的命令：pnpm preview')
  })

  it('does not truncate an unstructured report or its failure at the end', async () => {
    const call = await profiles.dispatch(parentId, reviewer.id, 'Review')
    await waitFor(() => store.call(call.id).state === 'running')
    const report = `${'evidence '.repeat(3000)}\nFAILED: remaining issue`
    complete(chats.get(call.conversationId).sessionId!, report, true)
    await waitFor(() => store.call(call.id).delivered)
    const delivered = chats.messages(parentId).find((message) => message.text.includes(call.id))?.text ?? ''
    expect(delivered).toContain('FAILED: remaining issue')
    expect(delivered).toContain('\"state\":\"failed\"')
    expect(store.call(call.id).result).toBe(report)
  })

  it('limits role callers, refuses nested dispatch and caps a planning caller to read-only', async () => {
    const developer = profiles.save({ name: 'Developer', agent: 'claude', capability: 'develop' })
    conversations.setWorkspaceReadOnly(parentId, true)
    const call = await profiles.dispatch(parentId, developer.id, 'Analyze the implementation')
    expect(call.readOnly).toBe(true)
    await waitFor(() => store.call(call.id).state === 'running')
    expect(chats.get(call.conversationId).workspaceReadOnly).toBe(true)
    await expect(profiles.dispatch(call.conversationId, reviewer.id, 'Nested work')).rejects.toMatchObject({ reason: 'agent-call-unavailable' })
    conversations.setProfile(parentId, profiles.save({ name: 'Restricted', agent: 'claude', callableProfiles: [] }))
    expect(profiles.available(parentId)).toEqual([])
    await expect(profiles.dispatch(parentId, reviewer.id, 'Not allowed')).rejects.toMatchObject({ reason: 'agent-call-forbidden' })
  })
  it('runs one developer at a time, prevents parent edits and cancels without deleting files', async () => {
    const developer = profiles.save({ name: 'Developer', agent: 'claude', capability: 'develop' })
    const first = await profiles.dispatch(parentId, developer.id, 'Implement part one')
    const second = await profiles.dispatch(parentId, developer.id, 'Implement part two')
    await waitFor(() => store.call(first.id).state === 'running')
    expect(store.call(second.id).state).toBe('queued')
    await expect(chats.send(parentId, 'Edit the same files')).rejects.toMatchObject({ reason: 'agent-call-writing' })
    await profiles.cancelForParent(parentId)
    expect(profiles.calls(parentId).map((call) => call.state)).toEqual(['cancelled', 'cancelled'])
    expect(chats.get(first.conversationId).sessionId).toBeNull()
    expect(profiles.calls(parentId).every((call) => call.delivered)).toBe(true)
  })
  it('deletes completed and running delegate histories with their parent without reentering the dispatch lock', async () => {
    const first = await profiles.dispatch(parentId, reviewer.id, 'Finished review')
    const second = await profiles.dispatch(parentId, reviewer.id, 'Still working')
    await waitFor(() => store.call(first.id).state === 'running' && store.call(second.id).state === 'running')
    complete(chats.get(first.conversationId).sessionId!, 'Review complete')
    await waitFor(() => store.call(first.id).delivered)
    const project = chats.get(parentId).workspacePath
    await chats.delete(parentId)
    expect(conversations.get(parentId)).toBeNull()
    expect(conversations.get(first.conversationId)).toBeNull()
    expect(conversations.get(second.conversationId)).toBeNull()
    expect(store.calls()).toEqual([])
    expect(project).toBeTruthy()
    await profiles.reconcile()
    expect(store.calls()).toEqual([])
  })

  it('sends failures back to the parent instead of treating them as success', async () => {
    const call = await profiles.dispatch(parentId, reviewer.id, 'Review')
    await waitFor(() => store.call(call.id).state === 'running')
    complete(chats.get(call.conversationId).sessionId!, 'Could not read the file', true)
    await waitFor(() => store.call(call.id).delivered)
    expect(store.call(call.id).state).toBe('failed')
    expect(chats.messages(parentId).some((message) => message.text.includes('"state":"failed"'))).toBe(true)
  })
  it('restores queued work and archived roles do not change its saved snapshot', async () => {
    await chats.send(parentId, 'Working')
    const call = await profiles.dispatch(parentId, reviewer.id, 'Review later')
    profiles.archive(reviewer.id, true)
    expect(profiles.available(parentId)).toEqual([])
    await profiles.close()
    store = new AgentProfileStore(path.join(root, 'conclave.db'))
    profiles = new AgentProfileService(store, chats, { profile: () => {}, call: () => {} })
    complete(chats.get(parentId).sessionId!, 'ready')
    await profiles.reconcile()
    await waitFor(() => store.call(call.id).state === 'running')
    expect(chats.get(call.conversationId).profile?.archivedAt).toBeNull()
  })

  it('returns work to a task conversation and preserves its planning constraint', async () => {
    const parent = await chats.startForTask({ id: 'task-1', title: 'Plan a feature', agent: 'claude' }, {
      cwd: chats.get(parentId).workspacePath, extraDirs: [], planOnly: true, session: 'new', permissionMode: 'plan'
    })
    const call = await profiles.dispatch(parent.id, reviewer.id, 'Analyze the API')
    await waitFor(() => store.call(call.id).state === 'running')
    complete(chats.get(call.conversationId).sessionId!, 'API analysis complete')
    await waitFor(() => store.call(call.id).delivered)
    expect(chats.get(parent.id)).toMatchObject({ taskId: 'task-1', planOnly: true })
    expect(chats.messages(parent.id).some((message) => message.text.includes('API analysis complete'))).toBe(true)
  })

  it('serializes writers across conversations sharing a directory while readers run together', async () => {
    const developer = profiles.save({ name: 'Developer', agent: 'claude', capability: 'develop' })
    const other = await chats.create('claude', chats.get(parentId).projectPaths, false, { permissionMode: 'ask' })
    const first = await profiles.dispatch(parentId, developer.id, 'Edit the module')
    await waitFor(() => store.call(first.id).state === 'running')
    const second = await profiles.dispatch(other.id, developer.id, 'Edit the same module')
    const reader = await profiles.dispatch(other.id, reviewer.id, 'Inspect the module')
    await waitFor(() => store.call(reader.id).state === 'running')
    expect(store.call(second.id).state).toBe('queued')
    await expect(chats.send(other.id, 'Edit while another writer runs')).rejects.toMatchObject({ reason: 'agent-call-writing' })
    await profiles.cancelForParent(parentId)
    profiles.tick()
    await waitFor(() => store.call(second.id).state === 'running')
    expect(chats.list(false, false, true).some((conversation) => conversation.id === second.conversationId)).toBe(true)
  })

  it('starts members once the caller\'s turn ends, leaving the dev server it runs alone', async () => {
    await chats.send(parentId, 'Start the dev server, then get a review')
    const session = chats.get(parentId).sessionId!
    background(session, 'bg-parent', 'pnpm dev')
    const call = await profiles.dispatch(parentId, reviewer.id, 'Review the module')
    await waitFor(() => store.call(call.id).waiting === 'parent')
    expect(store.call(call.id).state).toBe('queued')
    complete(session, 'delegated')
    await waitFor(() => store.call(call.id).state === 'running')
    expect(store.call(call.id).waiting).toBeNull()
    expect(chats.get(parentId)).toMatchObject({ sessionId: session, chat: { turn: 'running' } })
    complete(chats.get(call.conversationId).sessionId!, 'No defects found')
    await waitFor(() => store.call(call.id).delivered)
    expect(chats.get(parentId).sessionId).toBe(session)
    expect(chats.messages(parentId).some((message) => message.text.includes('No defects found'))).toBe(true)
  })

  it('frees an idle caller\'s slot while its members work', async () => {
    await chats.send(parentId, 'Get a review')
    const call = await profiles.dispatch(parentId, reviewer.id, 'Review the module')
    complete(chats.get(parentId).sessionId!, 'delegated')
    await waitFor(() => store.call(call.id).state === 'running')
    expect(chats.get(parentId).sessionId).toBeNull()
  })

  it('finishes a member that leaves a command running, stopping it and saying so', async () => {
    const call = await profiles.dispatch(parentId, reviewer.id, 'Check the preview')
    await waitFor(() => store.call(call.id).state === 'running')
    const child = chats.get(call.conversationId)
    background(child.sessionId!, 'bg-child', 'pnpm preview')
    complete(child.sessionId!, 'The preview is up on port 4173\n<conclave-summary>\n结论：预览已启动\n改动：无\n验证：预览运行\n未解决：无\n</conclave-summary>')
    await waitFor(() => store.call(call.id).delivered)
    expect(store.call(call.id).state).toBe('completed')
    expect(store.call(call.id).result).toContain('已停止成员留在后台的命令：pnpm preview')
    expect(chats.messages(parentId).find((message) => message.text.includes(call.id))?.text).toContain('已停止成员留在后台的命令：pnpm preview')
    expect(chats.get(child.id).sessionId).toBeNull()
  })

  it('lets an edit start beside a dev server another conversation runs, and tells the member of it', async () => {
    const developer = profiles.save({ name: 'Developer', agent: 'claude', capability: 'develop' })
    const other = await chats.create('claude', chats.get(parentId).projectPaths, false, { permissionMode: 'ask' })
    await chats.send(other.id, 'Run the dev server')
    const session = chats.get(other.id).sessionId!
    background(session, 'bg-other', 'pnpm dev --port 5173')
    const call = await profiles.dispatch(parentId, developer.id, 'Edit the module')
    await waitFor(() => store.call(call.id).waiting === 'writer')
    complete(session, 'The server runs')
    await waitFor(() => store.call(call.id).state === 'running')
    expect(chats.get(other.id).sessionId).toBe(session)
    expect(chats.messages(call.conversationId).some((message) => message.role === 'user' && message.text.includes('- pnpm dev --port 5173'))).toBe(true)
  })

  it('says a member waits for a free slot', async () => {
    const other = await chats.create('claude', chats.get(parentId).projectPaths, false, { permissionMode: 'ask' })
    await chats.send(other.id, 'Busy elsewhere')
    chats.setCapacity({ maxConcurrentAgents: 20, agentConcurrency: { claude: 1 } }, () => profiles.tick())
    const call = await profiles.dispatch(parentId, reviewer.id, 'Review the module')
    await waitFor(() => store.call(call.id).waiting === 'capacity')
    expect(store.call(call.id).state).toBe('queued')
  })

  it('shows a member back at work as soon as its request is answered', async () => {
    const call = await profiles.dispatch(parentId, reviewer.id, 'Inspect the module')
    await waitFor(() => store.call(call.id).state === 'running')
    const child = chats.get(call.conversationId)
    daemon.emit(child.sessionId!, { type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_ask-1' } })
    await waitFor(() => store.call(call.id).state === 'awaiting')
    await chats.respond(child.id, 'ask-1', { decision: 'allow' })
    await waitFor(() => store.call(call.id).state === 'running')
    complete(child.sessionId!, 'Inspected')
    await waitFor(() => store.call(call.id).state === 'completed')
  })

  it('marks a vanished process as failed after reconciliation', async () => {
    const call = await profiles.dispatch(parentId, reviewer.id, 'Inspect the module')
    await waitFor(() => store.call(call.id).state === 'running')
    await chats.stop(call.conversationId)
    await profiles.reconcile()
    expect(store.call(call.id)).toMatchObject({ state: 'failed', delivered: true })
  })
})
