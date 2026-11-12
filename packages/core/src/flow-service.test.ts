import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskContractFields, type ChatItem, type CheckResult, type Conversation, type Flow, type HiddenTestPlan, type Task, type TaskContract } from '@conclave/protocol'
import { FlowService } from './flow-service'
import { FlowStore } from './flow-store'
import type { TaskService } from './task-service'
import { TaskStore } from './task-store'

describe('FlowService', () => {
  let dir: string
  let store: FlowStore
  let flows: FlowService
  let submitted: boolean
  let sends: string[]
  let handoffs: string[]
  let checkResults: CheckResult[] | null
  let checkThrows: string | null
  let checkedHidden: HiddenTestPlan | null
  let checkedEnv: Readonly<Record<string, string>> | undefined
  let checkpoints: string[]
  let rollbacks: string[]
  const conversationId = '00000000-0000-4000-8000-000000000001'
  let conversation: { id: string; chat: { turn: 'idle' | 'running' | 'awaiting' } }
  let items: ChatItem[]
  let contract: TaskContract
  let taskService: Pick<TaskService, 'get' | 'start' | 'create' | 'attachConversation' | 'check' | 'submit' | 'contract' | 'handoff' | 'assignAgent'>
  let chatsService: ConstructorParameters<typeof FlowService>[2]

  const task = {
    id: 'task-1',
    title: 'Add a filter',
    details: 'Filter the list by project',
    status: 'pending',
    repos: [],
    dependsOn: [],
    agent: 'claude'
  } as unknown as Task

  const fail = (signature = 'sig', status: 'fail' | 'blocked' = 'fail'): CheckResult => ({
    repo: '/repo', command: 'pnpm test', status, exitCode: 1, durationMs: 1,
    tail: 'test failed: boom', signature, failures: ['test failed: boom'], flaky: false
  })
  const pass = (): CheckResult => ({
    repo: '/repo', command: 'pnpm test', status: 'pass', exitCode: 0, durationMs: 1,
    tail: '', signature: 'ok', failures: [], flaky: false
  })
  let turnClock = Date.now()
  const turn = (): ChatItem => {
    turnClock = Math.max(Date.now(), turnClock + 1)
    return { kind: 'turn', id: `turn-${turnClock}`, stageId: 's', revision: 1, at: turnClock, state: 'completed' } as ChatItem
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-flow-'))
    const db = path.join(dir, 'conclave.db')
    new TaskStore(db).close()
    store = new FlowStore(db)
    submitted = false
    sends = []
    handoffs = []
    checkResults = []
    checkThrows = null
    checkedHidden = null
    checkedEnv = undefined
    checkpoints = []
    rollbacks = []
    conversation = { id: conversationId, chat: { turn: 'idle' } }
    items = []
    contract = { ...TaskContractFields.parse({}), updatedAt: 0 }
    taskService = {
      get: () => task,
      start: async () => ({ ...task, status: 'running', conversationId }),
      check: async (_id: string, hidden?: HiddenTestPlan | null, extraEnv?: Readonly<Record<string, string>>) => {
        checkedHidden = hidden ?? null
        checkedEnv = extraEnv
        if (checkThrows) throw new Error(checkThrows)
        return checkResults
      },
      submit: () => { submitted = true; return { ...task, status: 'review' } },
      contract: () => contract,
      handoff: async (_id: string, agent: string) => { handoffs.push(agent); return { ...task, agent } },
      assignAgent: (_id: string, agent: string) => ({ ...task, agent }),
      create: (fields: { title: string }) => ({ ...task, ...fields }),
      attachConversation: () => ({ ...task, status: 'running', conversationId }),
      checkpointWorktree: (_id: string, message: string) => {
        const sha = `commit-${checkpoints.length + 1}`
        checkpoints.push(`${sha}:${message}`)
        return sha
      },
      restoreWorktreeCheckpoint: (_id: string, commit: string) => {
        rollbacks.push(commit)
        return true
      }
    } as unknown as Pick<TaskService, 'get' | 'start' | 'create' | 'attachConversation' | 'check' | 'submit' | 'contract' | 'handoff' | 'assignAgent'>
    chatsService = {
      get: () => conversation as unknown as Conversation,
      send: async (_id: string, text: string) => { sends.push(text) },
      chatPage: () => ({ items }),
      interrupt: async () => {},
      stop: async () => {}
    } as unknown as ConstructorParameters<typeof FlowService>[2]
    flows = new FlowService(store, taskService, chatsService, { changed: () => {} })
  })
  afterEach(() => {
    flows.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const start = async (): Promise<Flow> => {
    const flow = await flows.start('task-1')
    // The start's own advance saw an empty chat; the turn below is the implementation.
    items = [turn()]
    await flows.reconcile()
    return store.get(flow.id)
  }

  const startWithFailure = async (results: CheckResult[]): Promise<Flow> => {
    checkResults = results
    const flow = await flows.start('task-1')
    items = [turn()]
    await flows.reconcile()
    return store.get(flow.id)
  }

  it('adds the agents the machine can run to the candidate pool', async () => {
    flows.setAvailableAgents(async () => ['codex', 'claude'])
    const flow = await flows.start('task-1')
    expect(flow.candidates).toEqual(['claude', 'codex'])
    expect(flow.nodes.find((node) => node.key === 'implement')?.agent).toBe('claude')
  })

  it('starts a run from an existing conversation', async () => {
    conversation = { id: conversationId, chat: { turn: 'idle' }, projectPaths: ['/repo'], agent: 'claude', title: 'Fix the filter' } as unknown as typeof conversation
    const flow = await flows.startFromConversation(conversationId)
    expect(flow.nodes.find((node) => node.key === 'implement')?.conversationId).toBe(conversationId)
    items = [turn()]
    await flows.reconcile()
    expect(store.get(flow.id).state).toBe('review')
  })

  it('chooses an agent when the task has none', async () => {
    const noAgent = { ...task, agent: null } as Task
    let assigned: string | null = null
    const tasks = {
      get: () => noAgent,
      start: async () => ({ ...noAgent, agent: assigned, status: 'running', conversationId }),
      check: async () => checkResults,
      submit: () => { submitted = true; return { ...noAgent, status: 'review' } },
      contract: () => contract,
      handoff: async () => noAgent,
      assignAgent: (_id: string, agent: string) => { assigned = agent; return { ...noAgent, agent } },
      create: (fields: { title: string }) => ({ ...noAgent, ...fields }),
      attachConversation: () => ({ ...noAgent, status: 'running', conversationId })
    } as unknown as Pick<TaskService, 'get' | 'start' | 'create' | 'attachConversation' | 'check' | 'submit' | 'contract' | 'handoff' | 'assignAgent'>
    const service = new FlowService(store, tasks, chatsService, { changed: () => {} })
    service.setAvailableAgents(async () => ['codex'])
    const flow = await service.start('task-1')
    expect(assigned).toBe('codex')
    expect(flow.attempts[0]?.agent).toBe('codex')
    service.close()
  })

  it('runs a plan graph step by step and verifies each step', async () => {
    const steps = [{ title: 'one', instruction: 'do one', agent: null }, { title: 'two', instruction: 'do two', agent: null }]
    const withPlanner = new FlowService(store, taskService, chatsService, { changed: () => {} }, null, null, null, { plan: async () => steps })
    const flow = await withPlanner.start('task-1')
    expect(flow.nodes.map((node) => node.key)).toEqual(['plan', 'implement-1', 'verify-1', 'implement-2', 'verify-2'])
    expect(flow.nodes.find((node) => node.key === 'implement-1')?.state).toBe('running')

    items = [turn()]
    checkResults = []
    await withPlanner.reconcile()
    let current = store.get(flow.id)
    expect(current.nodes.find((node) => node.key === 'verify-1')?.state).toBe('done')
    expect(current.nodes.find((node) => node.key === 'implement-2')?.state).toBe('running')
    expect(sends.at(-1)).toContain('do two')

    items = [turn()]
    checkResults = []
    await withPlanner.reconcile()
    current = store.get(flow.id)
    expect(current.state).toBe('review')
    expect(current.nodes.find((node) => node.key === 'verify-2')?.state).toBe('done')
    expect(submitted).toBe(true)
    withPlanner.close()
  })

  it('hands a step to the agent the plan names for it', async () => {
    const steps = [
      { title: 'api', instruction: 'do the api', agent: 'claude' as const },
      { title: 'ui', instruction: 'do the ui', agent: 'codex' as const }
    ]
    let roster: readonly string[] = []
    const withPlanner = new FlowService(store, taskService, chatsService, { changed: () => {} }, null, null, null, {
      plan: async (_task, agents = []) => { roster = agents; return steps }
    })
    withPlanner.setAvailableAgents(async () => ['claude', 'codex'])
    const flow = await withPlanner.start('task-1')
    expect(roster).toEqual(['claude', 'codex'])
    expect(flow.nodes.find((node) => node.key === 'implement-1')?.agent).toBe('claude')
    expect(flow.nodes.find((node) => node.key === 'implement-2')?.agent).toBe('codex')

    items = [turn()]
    checkResults = []
    await withPlanner.reconcile()
    const current = store.get(flow.id)
    expect(handoffs).toEqual(['codex'])
    expect(current.nodes.find((node) => node.key === 'implement-2')?.agent).toBe('codex')
    expect(current.attempts.at(-1)?.agent).toBe('codex')
    expect(sends.at(-1)).toContain('do the ui')
    withPlanner.close()
  })

  it('ignores a step whose agent this machine is not running', async () => {
    const steps = [{ title: 'api', instruction: 'do the api', agent: 'kimi' as const }, { title: 'ui', instruction: 'do the ui', agent: null }]
    const withPlanner = new FlowService(store, taskService, chatsService, { changed: () => {} }, null, null, null, { plan: async () => steps })
    withPlanner.setAvailableAgents(async () => ['claude'])
    const flow = await withPlanner.start('task-1')
    expect(flow.nodes.find((node) => node.key === 'implement-1')?.agent).toBe('claude')
    items = [turn()]
    checkResults = []
    await withPlanner.reconcile()
    expect(handoffs).toEqual([])
    withPlanner.close()
  })

  it('waits for the test author and gives the hidden plan to the verifier', async () => {
    const plan: HiddenTestPlan = { command: 'pnpm test hidden', files: [{ path: 'tests/a.test.ts', content: 'test' }], note: 'login', timeoutMs: 600_000 }
    const withAuthor = new FlowService(store, taskService, chatsService, { changed: () => {} }, { author: async () => plan })
    const flow = await withAuthor.start('task-1')
    items = [turn()]
    withAuthor.observe(conversationId, items)
    await expect.poll(() => store.get(flow.id).state, { timeout: 3000 }).toBe('review')
    expect(store.get(flow.id).hiddenTests).toEqual(plan)
    expect(checkedHidden).toEqual(plan)
    expect(store.get(flow.id).testAuthor).toBe('done')
  })

  it('gives the verifier the implement conversation’s MCP selection', async () => {
    const plan: HiddenTestPlan = { command: 'pnpm test hidden', files: [{ path: 'tests/a.test.ts', content: 'test' }], note: 'login', timeoutMs: 600_000 }
    conversation = { id: conversationId, chat: { turn: 'idle' }, profile: { mcpServers: ['docs'] } } as unknown as typeof conversation
    const asked: (readonly string[] | null)[] = []
    const withAuthor = new FlowService(store, taskService, chatsService, { changed: () => {} }, {
      author: async (_task, mcpServers) => { asked.push(mcpServers); return plan }
    })
    const flow = await withAuthor.start('task-1')
    items = [turn()]
    withAuthor.observe(conversationId, items)
    await expect.poll(() => store.get(flow.id).testAuthor, { timeout: 3000 }).toBe('done')
    expect(asked).toEqual([['docs']])
    withAuthor.close()
  })

  it('does not verify with hidden tests that already pass on the base', async () => {
    const plan: HiddenTestPlan = { command: 'pnpm test hidden', files: [{ path: 'tests/a.test.ts', content: 'test' }], note: 'login', timeoutMs: 600_000 }
    const withAuthor = new FlowService(store, taskService, chatsService, { changed: () => {} }, { author: async () => plan }, {
      run: async () => ({ status: 'not-red' as const, result: null, reason: '隐藏测试在起点已经通过' })
    })
    const flow = await withAuthor.start('task-1')
    items = [turn()]
    withAuthor.observe(conversationId, items)
    await expect.poll(() => store.get(flow.id).state, { timeout: 3000 }).toBe('paused')
    expect(store.get(flow.id).hiddenTests).toBeNull()
    expect(store.get(flow.id).note).toContain('已经通过')
    expect(checkedHidden).toBeNull()
  })

  it('runs the hidden tests when red-first confirms them', async () => {
    const plan: HiddenTestPlan = { command: 'pnpm test hidden', files: [{ path: 'tests/a.test.ts', content: 'test' }], note: 'login', timeoutMs: 600_000 }
    const withAuthor = new FlowService(store, taskService, chatsService, { changed: () => {} }, { author: async () => plan }, {
      run: async () => ({ status: 'red' as const, result: null, reason: '红检成立' })
    })
    const flow = await withAuthor.start('task-1')
    items = [turn()]
    withAuthor.observe(conversationId, items)
    await expect.poll(() => store.get(flow.id).state, { timeout: 3000 }).toBe('review')
    expect(store.get(flow.id).hiddenTests).toEqual(plan)
    expect(checkedHidden).toEqual(plan)
    expect(store.get(flow.id).redFirst).toBe('red')
  })

  it('says in the report when no hidden tests were authored', async () => {
    const withAuthor = new FlowService(store, taskService, chatsService, { changed: () => {} }, { author: async () => null })
    const flow = await withAuthor.start('task-1')
    items = [turn()]
    checkResults = []
    await withAuthor.reconcile()
    const done = store.get(flow.id)
    expect(done.testAuthor).toBe('failed')
    expect(done.report).toContain('隐藏测试：未生成')
    withAuthor.close()
  })

  it('asks a planner for a new approach after a second failure', async () => {
    let calls = 0
    const withPlanner = new FlowService(store, taskService, chatsService, { changed: () => {} }, null, null, {
      propose: async () => { calls++; return { diagnosis: 'the route is missing', instruction: 'add the route first', steps: [] } }
    })
    const flow = await withPlanner.start('task-1')
    items = [turn()]
    checkResults = [fail('one')]
    withPlanner.observe(conversationId, items)
    await expect.poll(() => store.get(flow.id).nodes.find((node) => node.key === 'implement')?.attempts, { timeout: 3000 }).toBe(2)

    items = [turn()]
    checkResults = [fail('two')]
    withPlanner.observe(conversationId, items)
    await expect.poll(() => store.get(flow.id).replan !== null, { timeout: 3000 }).toBe(true)
    expect(calls).toBe(1)
    expect(sends.at(-1)).toContain('新的做法')
    expect(store.get(flow.id).replans).toHaveLength(1)
  })

  it('pauses a run that outlives its wall clock', async () => {
    const flow = await flows.start('task-1')
    store.patched(flow.id, { createdAt: Date.now() - flow.maxWallClockMs - 1 })
    flows.tick()
    const paused = store.get(flow.id)
    expect(paused.state).toBe('paused')
    expect(paused.note).toContain('运行超过')
  })

  it('runs one implement turn, checks it, and hands the task in', async () => {
    const flow = await start()
    const done = store.get(flow.id)
    expect(done.state).toBe('review')
    expect(submitted).toBe(true)
    expect(done.nodes.find((node) => node.key === 'implement')?.state).toBe('done')
    expect(done.nodes.find((node) => node.key === 'verify')?.state).toBe('done')
  })

  it('sends a failed check back for another attempt', async () => {
    checkResults = [fail()]
    const first = await start()
    expect(first.state).toBe('running')
    expect(first.nodes.find((node) => node.key === 'implement')?.attempts).toBe(2)
    expect(sends[0]).toContain('上一轮验收没有通过')
    expect(sends[0]).toContain('之前的尝试')
    expect(sends[0]).toContain('#1')

    items = [turn()]
    checkResults = [pass()]
    await flows.reconcile()
    expect(store.get(first.id).state).toBe('review')
    expect(submitted).toBe(true)
  })

  it('stops when the same failure repeats instead of spending another attempt', async () => {
    const flow = await startWithFailure([fail('sig')])
    expect(store.get(flow.id).attempts[0]).toMatchObject({ result: 'fail', failureKind: 'test', signature: 'sig' })
    checkResults = [fail('sig')]
    items = [turn()]
    await flows.reconcile()
    const paused = store.get(flow.id)
    expect(paused.state).toBe('paused')
    expect(paused.note).toContain('同一失败重复')
  })

  it('switches to another candidate after two failures from the same agent', async () => {
    const flow = await flows.start('task-1', false, ['claude', 'codex'])
    items = [turn()]
    checkResults = [fail('one')]
    await flows.reconcile()
    expect(store.get(flow.id).nodes.find((node) => node.key === 'implement')?.attempts).toBe(2)
    items = [turn()]
    checkResults = [fail('two')]
    await flows.reconcile()
    expect(handoffs).toEqual(['codex'])
    expect(store.get(flow.id).nodes.find((node) => node.key === 'implement')?.agent).toBe('codex')
  })

  it('adopts the task conversation a restart dropped while the flow was starting', async () => {
    const tasks = { ...taskService, get: () => ({ ...task, conversationId }) as Task }
    const service = new FlowService(store, tasks, chatsService, { changed: () => {} })
    const flow = await service.start('task-1')
    store.patched(flow.id, { nodes: store.get(flow.id).nodes.map((node) => ({ ...node, conversationId: null })) })
    items = [turn()]
    checkResults = []
    await service.reconcile()
    expect(store.get(flow.id).state).toBe('review')
    service.close()
  })

  it('waits on an environment failure and can be supplied with environment', async () => {
    const envCheck: CheckResult = { repo: '/repo', command: 'cargo test', status: 'blocked', exitCode: 127, durationMs: 1, tail: 'cargo: command not found', signature: 'cargo-missing', failures: ['cargo: command not found'], flaky: false }
    const flow = await startWithFailure([envCheck])
    expect(flow.state).toBe('waiting_environment')
    expect(flow.note).toContain('等待环境就绪')
    expect(flow.demand?.type).toBe('command')
    expect(flow.demand?.target).toBe('cargo')
    expect(sends).toHaveLength(0)

    const resumed = await flows.supplyEnvironment(flow.id, { mcpServers: ['rust-tools'], note: 'cargo ready' })
    expect(resumed.state).toBe('running')
    expect(resumed.demand).toBeNull()
    expect(sends).toHaveLength(1)
  })

  it('pauses when the attempts run out', async () => {
    contract = { ...TaskContractFields.parse({ constraints: { maxAttempts: 1 } }), updatedAt: 0 }
    checkResults = [fail()]
    const flow = await start()
    expect(flow.state).toBe('paused')
    expect(flow.note).toContain('验收未通过')
    expect(flow.report).toContain('尝试')
    expect(submitted).toBe(false)
  })

  it('pauses on the implement turn\'s own failure instead of waiting for the wall clock', async () => {
    const started = await flows.start('task-1')
    items = [{ ...turn(), state: 'failed', error: 'no API key for provider route "deepseek-official"' } as ChatItem]
    await flows.reconcile()
    const flow = store.get(started.id)
    expect(flow.state).toBe('paused')
    expect(flow.note).toContain('no API key')
    expect(flow.nodes.find((node) => node.key === 'implement')?.state).toBe('failed')
    expect(flow.attempts[0]).toMatchObject({ state: 'failed' })
    expect(flow.nodes.find((node) => node.key === 'verify')?.state).toBe('pending')
    expect(submitted).toBe(false)
  })

  it('pauses when the implement turn was interrupted', async () => {
    const started = await flows.start('task-1')
    items = [{ ...turn(), state: 'interrupted' } as ChatItem]
    await flows.reconcile()
    const flow = store.get(started.id)
    expect(flow.state).toBe('paused')
    expect(flow.note).toContain('被中断')
    expect(submitted).toBe(false)
  })

  it('pauses while the agent waits on the user', async () => {
    conversation.chat.turn = 'awaiting'
    const started = await flows.start('task-1')
    items = [turn()]
    await flows.reconcile()
    const flow = store.get(started.id)
    expect(flow.state).toBe('paused')
    expect(flow.note).toContain('等待你处理')
  })

  it('pauses when the verifier itself cannot run', async () => {
    checkThrows = 'project-config-untrusted: /repo'
    const flow = await start()
    expect(flow.state).toBe('paused')
    expect(flow.note).toContain('验收检查无法运行')
    expect(flow.note).toContain('project-config-untrusted')
    expect(submitted).toBe(false)
  })

  it('pauses when there is no check to verify with', async () => {
    checkResults = null
    const flow = await start()
    expect(flow.state).toBe('paused')
    expect(flow.note).toContain('没有可执行的验收检查')
    expect(submitted).toBe(false)
  })

  it('cancels without submitting and can resume a paused run', async () => {
    contract = { ...TaskContractFields.parse({ constraints: { maxAttempts: 1 } }), updatedAt: 0 }
    checkResults = [fail()]
    const flow = await start()
    expect(flow.state).toBe('paused')
    const resumed = await flows.control(flow.id, 'resume')
    expect(resumed.state).toBe('running')
    expect(sends.at(-1)).toContain('继续完成')
    const cancelled = await flows.control(flow.id, 'cancel')
    expect(cancelled.state).toBe('cancelled')
    expect(submitted).toBe(false)
  })

  it('checkpoints improvements, rolls back regressions, and stops at target under metric ratchet', async () => {
    contract = {
      ...TaskContractFields.parse({
        verification: { ratchet: { direction: 'maximize', target: 90 } },
        constraints: { maxAttempts: 4 }
      }),
      updatedAt: 0
    }
    const scoreResult = (score: number): CheckResult => ({
      repo: '/repo',
      command: 'pnpm bench',
      status: 'pass',
      exitCode: 0,
      durationMs: 5,
      tail: `METRIC_SCORE=${score}`,
      signature: 'ok',
      failures: [],
      flaky: false
    })

    checkResults = [scoreResult(70)]
    const first = await start()
    expect(first.state).toBe('running')
    expect(first.bestScore).toBe(70)
    expect(first.bestCommit).toBe('commit-1')
    expect(first.attempts[0]?.metricScore).toBe(70)
    expect(rollbacks).toEqual([])
    expect(submitted).toBe(false)

    // Attempt 2 regresses to 60 -> rolled back to commit-1
    items = [turn()]
    checkResults = [scoreResult(60)]
    await flows.reconcile()
    const second = store.get(first.id)
    expect(second.state).toBe('running')
    expect(second.bestScore).toBe(70)
    expect(second.bestCommit).toBe('commit-1')
    expect(rollbacks).toEqual(['commit-1'])
    expect(sends.at(-1)).toContain('工作树已回滚到最佳检查点')

    // Attempt 3 reaches 92 >= target 90 -> checkpoints and submits to review
    items = [turn()]
    checkResults = [scoreResult(92)]
    await flows.reconcile()
    const third = store.get(first.id)
    expect(third.state).toBe('review')
    expect(third.bestScore).toBe(92)
    expect(third.bestCommit).toBe('commit-2')
    expect(third.report).toContain('最佳指标：METRIC_SCORE=92')
    expect(submitted).toBe(true)
  })

  it('injects supplied environment variables into checks without leaking secret values', async () => {
    const envBlocked: CheckResult = {
      repo: '/repo',
      command: 'pnpm test:integration',
      status: 'blocked',
      exitCode: 1,
      durationMs: 1,
      tail: 'Error: OPENAI_API_KEY is not set',
      signature: 'missing-key',
      failures: ['OPENAI_API_KEY is not set'],
      flaky: false
    }
    const waiting = await startWithFailure([envBlocked])
    expect(waiting.state).toBe('waiting_environment')

    const resumed = await flows.supplyEnvironment(waiting.id, {
      env: { OPENAI_API_KEY: 'sk-super-secret-value' },
      note: 'supplied key'
    })
    expect(resumed.state).toBe('running')
    expect(resumed.env).toEqual({ OPENAI_API_KEY: 'sk-super-secret-value' })
    expect(resumed.note).not.toContain('sk-super-secret-value')
    expect(sends.at(-1)).toContain('OPENAI_API_KEY')
    expect(sends.at(-1)).not.toContain('sk-super-secret-value')

    items = [turn()]
    checkResults = [pass()]
    await flows.reconcile()
    const finished = store.get(waiting.id)
    expect(finished.state).toBe('review')
    expect(checkedEnv).toEqual({ OPENAI_API_KEY: 'sk-super-secret-value' })
  })
})
