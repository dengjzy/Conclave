import { randomUUID } from 'node:crypto'
import {
  activeFlowNode,
  newCheckFailures,
  type AgentKind,
  type ChatItem,
  type CheckResult,
  type Conversation,
  type EnvironmentDemand,
  type Flow,
  type FlowNode,
  type HiddenTestPlan,
  type PlanStep,
  type Replan,
  type Task
} from '@conclave/protocol'
import type { ConversationService } from './conversation-service'
import type { FlowStore } from './flow-store'
import { defaultPlan, graphPlan } from './flow-planner'
import { attemptHistory, classifyFailure, detectEnvironmentDemand, failureSignature, parseRatchetMetrics } from './flow-policy'
import { Rejection } from './rejection'
import type { TaskService } from './task-service'
import type { RedFirstResult } from './red-first'

const RETRY_LIMIT = 4000

const failure = (error: unknown) => error instanceof Rejection ? error.reason : error instanceof Error ? error.message : String(error)

type FlowChats = Pick<ConversationService, 'get' | 'send' | 'chatPage' | 'interrupt' | 'stop' | 'setMcpServers'>
type FlowTasks = Pick<TaskService, 'get' | 'start' | 'create' | 'attachConversation' | 'check' | 'submit' | 'contract' | 'handoff' | 'assignAgent'>
type TestAuthor = { author(task: Task, mcpServers: readonly string[] | null): Promise<HiddenTestPlan | null> }
type RedFirst = { run(task: Task, conversationId: string, plan: HiddenTestPlan): Promise<RedFirstResult> }
type Replanner = { propose(task: Task, history: string, failure: string, mcpServers: readonly string[] | null): Promise<Replan | null> }
type Planner = { plan(task: Task, agents?: readonly AgentKind[]): Promise<PlanStep[] | null> }

// One autonomous run of a task. It starts the task, watches its chat for the implement turn, runs
// the task's checks, and either hands the task in or sends the failures back for another attempt.
// Process and worktree ownership stay in ConversationService and TaskService; this only advances
// the run and keeps its evidence in one place.
export class FlowService {
  private readonly chains = new Map<string, Promise<unknown>>()
  private available: () => Promise<readonly AgentKind[]> = async () => []
  private closed = false

  constructor(
    private readonly store: FlowStore,
    private readonly tasks: FlowTasks,
    private readonly chats: FlowChats,
    private readonly events: { changed: (flow: Flow) => void },
    private readonly testAuthor: TestAuthor | null = null,
    private readonly redFirst: RedFirst | null = null,
    private readonly replanner: Replanner | null = null,
    private readonly planner: Planner | null = null
  ) {}

  setAvailableAgents(available: () => Promise<readonly AgentKind[]>): void { this.available = available }

  list(taskId?: string): Flow[] { return this.store.list(taskId) }

  get(id: string): Flow { return this.store.get(id) }

  async start(taskId: string, allowBypass = false, candidates: readonly AgentKind[] = [], existingConversationId?: string): Promise<Flow> {
    let task = this.tasks.get(taskId)
    if (task.squadId) throw new Rejection('flow-squad-unsupported', '团队任务由团队自己推进')
    if (task.status !== 'pending') throw new Rejection('flow-task-not-pending')
    if (this.store.active(taskId)) throw new Rejection('flow-active')
    const installed = await this.available().catch(() => [])
    if (!task.agent) {
      const choice = this.pickAgent([...candidates, ...installed])
      if (!choice) throw new Rejection('flow-no-agent', '没有可用的 Agent，请先安装或登录一个')
      task = this.tasks.assignAgent(taskId, choice)
    }
    const contract = this.tasks.contract(taskId)
    const roster = [...new Set([...(task.agent ? [task.agent] : []), ...candidates, ...installed])]
    const steps = this.planner ? await this.planner.plan(task, roster).catch(() => null) : null
    // A step may only name an agent this run can start; anything else is the task's own agent.
    const allowed = new Set<AgentKind>(roster)
    const planned = steps?.map((step) => ({ ...step, agent: step.agent && allowed.has(step.agent) ? step.agent : null })) ?? null
    const plan = planned?.length ? graphPlan(task, contract, planned) : defaultPlan(task, contract)
    const now = Date.now()
    const implement = plan.nodes.find((node) => node.kind === 'implement')!
    implement.state = 'running'
    implement.attempts = 1
    implement.startedAt = now
    const flow: Flow = {
      id: randomUUID(),
      taskId,
      state: 'running',
      nodes: plan.nodes,
      attempts: [{ id: randomUUID(), nodeId: implement.id, number: 1, state: 'running', agent: implement.agent, result: null, failureKind: null, signature: null, error: null, startedAt: now, endedAt: null }],
      maxAttempts: plan.maxAttempts,
      maxWallClockMs: plan.maxWallClockMs,
      candidates: roster,
      hiddenTests: null,
      testAuthor: this.testAuthor ? 'pending' : 'skipped',
      redFirst: this.redFirst ? 'pending' : 'skipped',
      note: null,
      report: null,
      demand: null,
      replan: null,
      replans: [],
      createdAt: now,
      updatedAt: now
    }
    this.store.save(flow)
    this.announce(flow)
    try {
      if (existingConversationId) {
        this.tasks.attachConversation(taskId, existingConversationId)
        implement.conversationId = existingConversationId
        this.save(flow)
      } else {
        const started = await this.tasks.start(taskId, allowBypass, undefined, { permissionMode: 'acceptEdits' })
        if (!started.conversationId) throw new Rejection('flow-no-conversation')
        implement.conversationId = started.conversationId
        this.save(flow)
      }
      // The tests are authored while the implement conversation runs; the verifier waits for both.
      if (this.testAuthor) void this.authorTests(flow.id)
      // The first turn may already have ended before the conversation was recorded.
      await this.serially(flow.id, () => this.advance(flow.id)).catch(() => {})
    } catch (error) {
      flow.state = 'failed'
      flow.note = failure(error)
      implement.state = 'failed'
      implement.error = flow.note
      const attempt = flow.attempts[0]
      if (attempt) { attempt.state = 'failed'; attempt.error = flow.note; attempt.endedAt = Date.now() }
      this.save(flow)
      throw error
    }
    return this.store.get(flow.id)
  }

  // A run that starts from a chat uses that chat as its implement turn. A task record gives the
  // run a worktree/contract owner without opening a second conversation.
  async startFromConversation(conversationId: string, allowBypass = false): Promise<Flow> {
    const conversation = this.chats.get(conversationId)
    if (!conversation) throw new Rejection('conversation-not-found')
    if (conversation.projectPaths.length === 0) throw new Rejection('flow-no-project', '先在会话里选择一个项目')
    const title = conversation.title.trim().slice(0, 200) || '未命名任务'
    const task = this.tasks.create({ title, repos: conversation.projectPaths, agent: conversation.agent })
    return this.start(task.id, allowBypass, [conversation.agent], conversationId)
  }

  // A turn ended in a chat a flow owns: decide what that means for the run.
  observe(conversationId: string, items: readonly ChatItem[]): void {
    if (this.closed || !items.some((item) => item.kind === 'turn')) return
    const flow = this.store.list().find((each) => each.nodes.some((node) => node.conversationId === conversationId && node.state === 'running'))
    if (!flow) return
    void this.serially(flow.id, () => this.advance(flow.id)).catch(() => {})
  }

  // A running flow older than its deadline is paused, even if its agent or a terminal is stuck.
  tick(): void {
    for (const flow of this.store.list().filter((each) => each.state === 'running')) {
      if (Date.now() - flow.createdAt <= flow.maxWallClockMs) continue
      const node = activeFlowNode(flow) ?? flow.nodes.find((each) => each.kind === 'verify') ?? flow.nodes[0]
      if (node) this.pause(flow, node, `运行超过 ${Math.round(flow.maxWallClockMs / 60_000)} 分钟`)
    }
  }

  // After a restart: a running flow picks up from the turn its chat already finished.
  async reconcile(): Promise<void> {
    this.tick()
    for (const flow of this.store.list().filter((each) => each.state === 'running')) {
      // The author's child conversation does not survive a restart; go on with the command check.
      if (flow.testAuthor === 'running') this.save({ ...flow, testAuthor: 'failed' })
      if (flow.redFirst === 'running') this.save({ ...flow, redFirst: 'blocked' })
      await this.serially(flow.id, () => this.advance(flow.id))
    }
  }

  async control(id: string, action: 'cancel' | 'resume'): Promise<Flow> {
    return this.serially(id, async () => {
      const flow = this.store.get(id)
      if (action === 'cancel') {
        const node = activeFlowNode(flow)
        if (node?.conversationId) {
          await this.chats.interrupt(node.conversationId).catch(() => {})
          await this.chats.stop(node.conversationId).catch(() => {})
          node.state = 'skipped'
          node.endedAt = Date.now()
        }
        const attempt = flow.attempts.find((each) => each.state === 'running')
        if (attempt) { attempt.state = 'failed'; attempt.error = '用户停止'; attempt.endedAt = Date.now() }
        flow.state = 'cancelled'
        flow.note = '用户停止'
        flow.report = this.report(flow)
        return this.save(flow)
      }
      if (flow.state !== 'paused' && flow.state !== 'failed' && flow.state !== 'waiting_environment') throw new Rejection('flow-not-paused')
      return this.resume(flow)
    })
  }

  // Supplies missing environment (such as MCP servers or environment variables) to a flow
  // that was suspended waiting for environment setup.
  async supplyEnvironment(id: string, options: { mcpServers?: readonly string[]; env?: Record<string, string>; note?: string } = {}): Promise<Flow> {
    return this.serially(id, async () => {
      const flow = this.store.get(id)
      if (flow.state !== 'waiting_environment' && flow.state !== 'paused') throw new Rejection('flow-not-waiting-environment', '当前流程并未在等待环境补给')
      const implement = flow.nodes.find((node) => node.kind === 'implement')
      if (implement?.conversationId && options.mcpServers?.length && this.chats.setMcpServers) {
        const conversation = this.chats.get(implement.conversationId)
        if (conversation) {
          const current = conversation.mcpServers ?? []
          const merged = [...new Set([...current, ...options.mcpServers])]
          this.chats.setMcpServers(implement.conversationId, merged)
        }
      }
      flow.demand = null
      flow.state = 'running'
      flow.note = options.note ? `环境已就绪：${options.note}` : '环境已补充，恢复运行'
      const node = activeFlowNode(flow) ?? implement
      if (node?.conversationId) {
        await this.chats.send(node.conversationId, `环境已经配置完毕${options.note ? `（${options.note}）` : ''}。请重新运行验收检查，继续完成任务。`, [], false, false, this.ref(flow, node)).catch(() => {})
      }
      this.save(flow)
      this.announce(flow)
      void this.advance(flow.id).catch(() => {})
      return this.store.get(flow.id)
    })
  }

  close(): void { this.closed = true }

  private async resume(flow: Flow): Promise<Flow> {
    const failedVerify = flow.nodes.find((node) => node.kind === 'verify' && node.state === 'failed')
    const implement = failedVerify ? this.implementBefore(flow, failedVerify) : flow.nodes.find((node) => node.kind === 'implement')
    if (!implement?.conversationId) throw new Rejection('flow-no-conversation')
    // A person may resume past the automatic retry limit; the run is theirs to push.
    implement.state = 'running'
    implement.attempts += 1
    implement.startedAt = Date.now()
    implement.endedAt = null
    implement.error = null
    flow.attempts.push({ id: randomUUID(), nodeId: implement.id, number: implement.attempts, state: 'running', agent: implement.agent, result: null, failureKind: null, signature: null, error: null, startedAt: implement.startedAt, endedAt: null })
    flow.state = 'running'
    flow.demand = null
    flow.note = null
    this.save(flow)
    try {
      await this.chats.send(implement.conversationId, '继续完成这个任务，完成后停下来。', [], false, false, this.ref(flow, implement))
    } catch (error) {
      return this.pause(flow, implement, `继续失败：${failure(error)}`)
    }
    return this.store.get(flow.id)
  }

  private async advance(id: string): Promise<void> {
    if (this.closed) return
    let flow = this.store.get(id)
    if (flow.state !== 'running') return
    const node = activeFlowNode(flow)
    if (!node) return
    if (node.kind === 'implement') {
      // A core that restarted while the flow was starting can come back to a run whose node has
      // no conversation yet, though its task already has one. Adopt it instead of calling the run
      // dead.
      if (!node.conversationId) {
        const task = this.tasks.get(flow.taskId)
        if (task.conversationId) {
          node.conversationId = task.conversationId
          flow = this.save(flow)
        }
      }
      const conversation = this.conversation(node.conversationId)
      if (!conversation) { this.pause(flow, node, '任务对话不在了'); return }
      if (conversation.chat?.turn === 'awaiting') { this.pause(flow, node, '等待你处理审批或回答'); return }
      if (conversation.chat?.turn === 'running') return
      const ended = this.chatPage(node.conversationId).items.findLast((item) => item.kind === 'turn' && item.at >= (node.startedAt ?? 0))
      if (!ended || ended.kind !== 'turn') return
      // A turn that ended badly is final: waiting for it to become completed would hold the run
      // until the wall clock and then report a timeout instead of what went wrong.
      if (ended.state !== 'completed') {
        const reason = ended.state === 'failed'
          ? `实现回合失败：${ended.error?.trim() || 'Agent 没有给出原因'}`
          : '实现回合被中断'
        this.pause(flow, node, reason)
        return
      }
      // Wait before closing the implement node: a done node with no verify would stall the flow.
      if (flow.testAuthor === 'pending' || flow.testAuthor === 'running') return
      node.state = 'done'
      node.endedAt = Date.now()
      // The attempt stays running until the checks decide whether it passed.
      const at = flow.nodes.findIndex((each) => each.id === node.id)
      const next = flow.nodes[at + 1]
      if (!next) { this.pause(flow, node, '计划里没有再验收的节点'); return }
      next.state = 'running'
      next.startedAt = Date.now()
      flow = this.save(flow)
      // save returns a parsed copy; the node verified must be the one in that copy.
      await this.verify(flow, flow.nodes.find((each) => each.id === next.id)!)
      return
    }
    if (node.kind === 'verify') await this.verify(flow, node)
  }

  private async authorTests(id: string): Promise<void> {
    if (!this.testAuthor) return
    let flow = this.store.get(id)
    if (flow.testAuthor !== 'pending') return
    flow = this.save({ ...flow, testAuthor: 'running' })
    this.announce(flow)
    const plan = await this.testAuthor.author(this.tasks.get(flow.taskId), this.mcpServers(flow)).catch(() => null)
    if (!plan) {
      flow = this.store.get(id)
      flow.testAuthor = 'failed'
      this.save(flow)
      this.announce(flow)
      void this.serially(id, () => this.advance(id)).catch(() => {})
      return
    }
    if (this.redFirst) {
      flow = this.save({ ...this.store.get(id), redFirst: 'running' })
      this.announce(flow)
      const red = await this.redFirst.run(this.tasks.get(flow.taskId), flow.nodes.find((node) => node.kind === 'implement')?.conversationId ?? '', plan).catch((): RedFirstResult => ({ status: 'blocked', result: null, reason: 'red-first 无法运行' }))
      flow = this.store.get(id)
      flow.redFirst = red.status
      if (red.status === 'not-red') {
        flow.testAuthor = 'failed'
        flow.hiddenTests = null
        flow.state = 'paused'
        flow.note = red.reason
        this.save(flow)
        this.announce(flow)
        return
      }
      flow.hiddenTests = plan
      flow.testAuthor = 'done'
      if (red.status === 'blocked') flow.note = red.reason
    } else {
      flow = this.store.get(id)
      flow.hiddenTests = plan
      flow.testAuthor = 'done'
    }
    this.save(flow)
    this.announce(flow)
    void this.serially(id, () => this.advance(id)).catch(() => {})
  }

  // Unknown agents start at half; a recorded pass rate breaks the tie.
  private pickAgent(agents: readonly AgentKind[]): AgentKind | null {
    const stats = this.store.agentStats()
    return [...new Set(agents)].sort((a, b) => {
      const rate = (agent: AgentKind): number => {
        const stat = stats.get(agent)
        return stat?.attempts ? stat.passes / stat.attempts : 0.5
      }
      return rate(b) - rate(a)
    })[0] ?? null
  }

  private async verify(flow: Flow, node: FlowNode): Promise<void> {
    let results: CheckResult[] | null
    try {
      results = await this.tasks.check(flow.taskId, flow.hiddenTests)
    } catch (error) {
      this.pause(flow, node, `验收检查无法运行：${failure(error)}`)
      return
    }
    const contract = this.tasks.contract(flow.taskId)
    if (results === null && (contract?.verification.checks.length ?? 0) === 0) {
      this.pause(flow, node, '没有可执行的验收检查，不能自动提交')
      return
    }
    const failures = results === null ? ['验收检查无法运行'] : newCheckFailures(results, contract?.verification.baseline ?? [])
    if (failures.length > 0) {
      await this.retryOrPause(flow, node, results ?? [], failures)
      return
    }
    node.state = 'done'
    node.endedAt = Date.now()
    const implement = this.implementBefore(flow, node)
    const attempt = implement ? flow.attempts.find((each) => each.nodeId === implement.id && each.state === 'running') : undefined
    if (attempt) { attempt.state = 'done'; attempt.result = 'pass'; attempt.endedAt = Date.now() }
    const at = flow.nodes.findIndex((each) => each.id === node.id)
    const next = flow.nodes.slice(at + 1).find((each) => each.kind === 'implement' && each.state === 'pending')
    if (next) {
      const conversation = implement?.conversationId
      if (!conversation) { this.pause(flow, node, '计划里的下一步没有对话'); return }
      // The plan may give a step to another agent. The conversation stays the task's; handing it
      // over restarts it as that agent, with what was said so far.
      const target = next.agent ?? implement?.agent ?? null
      if (target && implement && target !== implement.agent) {
        try {
          await this.tasks.handoff(flow.taskId, target, `计划的下一步交给 ${target}：${next.instruction || next.key}`)
        } catch (error) {
          this.pause(flow, node, `切换到 ${target} 失败：${failure(error)}`)
          return
        }
        next.agent = target
      }
      next.state = 'running'
      next.conversationId = conversation
      next.attempts = 1
      next.startedAt = Date.now()
      flow.attempts.push({ id: randomUUID(), nodeId: next.id, number: 1, state: 'running', agent: next.agent, result: null, failureKind: null, signature: null, error: null, startedAt: next.startedAt, endedAt: null })
      flow = this.save(flow)
      this.announce(flow)
      try {
        await this.chats.send(conversation, next.instruction || '继续完成计划的下一步。', [], false, false, this.ref(flow, next))
      } catch (error) {
        this.pause(flow, next, `发送下一步失败：${failure(error)}`)
      }
      return
    }
    flow.state = 'review'
    flow.note = null
    flow.report = this.report(flow)
    this.save(flow)
    try {
      this.tasks.submit(flow.taskId)
    } catch (error) {
      this.pause(flow, node, `提交验收失败：${failure(error)}`)
      return
    }
    this.announce(this.store.get(flow.id))
  }

  private async retryOrPause(flow: Flow, verify: FlowNode, results: readonly CheckResult[], failures: readonly string[]): Promise<void> {
    verify.state = 'failed'
    verify.endedAt = Date.now()
    const detail = failures.join('\n\n').slice(0, RETRY_LIMIT)
    const implement = this.implementBefore(flow, verify)
    if (!implement?.conversationId) { this.pause(flow, verify, detail); return }

    const kind = classifyFailure(results)
    const signature = failureSignature(results)
    const attempt = flow.attempts.find((each) => each.nodeId === implement.id && each.state === 'running')
    if (attempt) {
      attempt.state = 'failed'
      attempt.result = 'fail'
      attempt.failureKind = kind
      attempt.signature = signature
      attempt.error = detail
      attempt.endedAt = Date.now()
    }

    const previous = flow.attempts.filter((each) => each.id !== attempt?.id).at(-1)
    if (previous?.signature && previous.signature === signature) {
      flow.state = 'paused'
      flow.note = `同一失败重复出现，已停止重试（${kind}）：\n${detail}`
      flow.report = this.report(flow)
      this.save(flow)
      this.announce(flow)
      return
    }
    if (kind === 'environment') {
      const demand = detectEnvironmentDemand(results)
      flow.state = 'waiting_environment'
      flow.demand = demand
      flow.note = `等待环境就绪（${demand?.type ?? 'env'}: ${demand?.target ?? 'unknown'}）：\n${detail}`
      flow.report = this.report(flow)
      this.save(flow)
      this.announce(flow)
      return
    }
    if (implement.attempts >= flow.maxAttempts) {
      flow.state = 'paused'
      flow.note = `验收未通过（已尝试 ${implement.attempts} 次，${kind}）：\n${detail}`
      flow.report = this.report(flow)
      this.save(flow)
      this.announce(flow)
      return
    }

    let replan: Replan | null = null
    if (this.replanner && implement.attempts >= 2 && flow.replans.length < 2) {
      replan = await this.replanner.propose(this.tasks.get(flow.taskId), attemptHistory(flow), detail, this.mcpServers(flow)).catch(() => null)
      if (replan) {
        flow.replans.push(replan)
        flow.replan = replan
      }
    }

    // Two failures from the same agent, or an unclassified one, are the signal to try someone else.
    // A new plan gets one round on the same agent before another switch.
    const sameAgentFailures = flow.attempts.filter((each) => each.agent === implement.agent && each.result === 'fail').length
    let next = implement.agent
    if (!replan && (kind === 'unknown' || sameAgentFailures >= 2)) next = this.nextAgent(flow, implement) ?? implement.agent
    if (next && next !== implement.agent) {
      try {
        await this.tasks.handoff(flow.taskId, next, `自动切换（${kind}）：上一轮验收未通过。`)
        implement.agent = next
      } catch (error) {
        this.pause(flow, implement, `切换到 ${next} 失败：${failure(error)}`)
        return
      }
    }

    implement.state = 'running'
    implement.attempts += 1
    implement.startedAt = Date.now()
    implement.endedAt = null
    implement.error = null
    flow.attempts.push({ id: randomUUID(), nodeId: implement.id, number: implement.attempts, state: 'running', agent: implement.agent, result: null, failureKind: null, signature: null, error: null, startedAt: implement.startedAt, endedAt: null })
    flow.state = 'running'
    flow.demand = null
    flow.note = null
    this.save(flow)
    try {
      const history = attemptHistory(flow)
      const ratchet = parseRatchetMetrics(results)
      const ratchetNote = ratchet.metricScore !== null ? `\n当前评估指标：METRIC_SCORE=${ratchet.metricScore}` : ''
      const guidance = replan
        ? `新的做法（第 ${flow.replans.length} 次）：\n诊断：${replan.diagnosis}\n下一步：${replan.instruction}${replan.steps.length ? `\n步骤：\n${replan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : ''}`
        : '不要重复同样的改法；先找出上一轮为什么没有通过，再动手。'
      const prompt = `上一轮验收没有通过（${kind}）。${ratchetNote}\n\n之前的尝试：\n${history || '（这是第一次）'}\n\n${guidance}\n\n${detail}`
      await this.chats.send(implement.conversationId, prompt, [], false, false, this.ref(flow, implement))
    } catch (error) {
      this.pause(flow, implement, `发送失败：${failure(error)}`)
      return
    }
    this.announce(this.store.get(flow.id))
  }

  private nextAgent(flow: Flow, implement: FlowNode): AgentKind | null {
    const tried = new Set(flow.attempts.flatMap((attempt) => attempt.agent ? [attempt.agent] : []))
    const candidates = flow.candidates.filter((agent) => agent !== implement.agent && !tried.has(agent))
    if (candidates.length === 0) return null
    const stats = this.store.agentStats()
    const rate = (agent: AgentKind): number => {
      const stat = stats.get(agent)
      return stat && stat.attempts > 0 ? stat.passes / stat.attempts : 0
    }
    return [...candidates].sort((a, b) => rate(b) - rate(a))[0] ?? null
  }

  private implementBefore(flow: Flow, node: FlowNode): FlowNode | null {
    const at = flow.nodes.findIndex((each) => each.id === node.id)
    return [...flow.nodes.slice(0, at)].reverse().find((each) => each.kind === 'implement') ?? null
  }

  private pause(flow: Flow, node: FlowNode, note: string): Flow {
    const current = this.store.get(flow.id)
    const target = current.nodes.find((each) => each.id === node.id)
    if (target) { target.state = 'failed'; target.error = note; target.endedAt = Date.now() }
    const attempt = current.attempts.find((each) => each.state === 'running')
    if (attempt) { attempt.state = 'failed'; attempt.error = note; attempt.endedAt = Date.now() }
    current.state = 'paused'
    current.note = note
    current.report = this.report(current)
    const saved = this.save(current)
    this.announce(saved)
    return saved
  }

  private report(flow: Flow): string {
    const implements_ = flow.nodes.filter((node) => node.kind === 'implement')
    const verifies = flow.nodes.filter((node) => node.kind === 'verify')
    const keyOf = (nodeId: string): string => flow.nodes.find((node) => node.id === nodeId)?.key ?? nodeId.slice(0, 8)
    const lines = [
      `状态：${flow.state}${flow.note ? ` · ${flow.note}` : ''}`,
      `实现：${implements_.map((node) => `${node.key} ${node.agent ?? '—'} · ${node.state} · 尝试 ${node.attempts} 次`).join('；') || '—'}`,
      `验收：${verifies.map((node) => `${node.key} ${node.state}`).join('；') || '—'}`,
      `尝试：`,
      ...flow.attempts.slice(-8).map((attempt) => `#${attempt.number} ${keyOf(attempt.nodeId)} ${attempt.agent ?? '—'} · ${attempt.result ?? attempt.state}${attempt.failureKind ? ` · ${attempt.failureKind}` : ''}`),
      flow.hiddenTests ? `隐藏测试：${flow.hiddenTests.files.length} 个文件 · ${flow.hiddenTests.command}` : flow.testAuthor === 'failed' ? '隐藏测试：未生成（测试作者没有给出计划，本次只有契约检查）' : '',
      flow.demand ? `等待环境：${flow.demand.type} · ${flow.demand.target} (${flow.demand.reason})` : '',
      flow.redFirst !== 'skipped' ? `Red-first：${flow.redFirst}` : '',
      flow.replan ? `最新重规划：${flow.replan.diagnosis}${flow.replan.steps.length ? `（${flow.replan.steps.length} 步）` : ''}` : ''
    ].filter(Boolean)
    return lines.join('\n').slice(0, 8000)
  }

  private conversation(id: string | null): Conversation | null {
    if (!id) return null
    try { return this.chats.get(id) } catch { return null }
  }

  // The implement conversation's user MCP selection, which a child agent keeps: it runs on the
  // servers the implementation was given, never on more.
  private mcpServers(flow: Flow): readonly string[] | null {
    const implement = flow.nodes.find((node) => node.kind === 'implement')
    const conversation = this.conversation(implement?.conversationId ?? null)
    return conversation?.mcpServers ?? conversation?.profile?.mcpServers ?? null
  }

  private chatPage(id: string | null): { items: readonly ChatItem[] } {
    if (!id) return { items: [] }
    try { return this.chats.chatPage(id) } catch { return { items: [] } }
  }

  private ref(flow: Flow, node: FlowNode): string {
    return `flow:${flow.id}:${node.id}:${node.attempts}`
  }

  private save(flow: Flow): Flow {
    return this.store.save({ ...flow, updatedAt: Date.now() })
  }

  private announce(flow: Flow): void {
    this.events.changed(flow)
  }

  private serially<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    this.chains.set(id, next)
    void next.finally(() => { if (this.chains.get(id) === next) this.chains.delete(id) }).catch(() => {})
    return next
  }
}
