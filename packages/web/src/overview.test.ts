import { describe, expect, it } from 'vitest'
import { Squad, SquadRun, Task, type Conversation, type Routine, type ScheduledRun } from '@conclave/protocol'
import { actionableItems } from './attention'
import { laterByDay, overview, waitBreakdown, type OverviewInput } from './overview'

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const now = at(14, 12)

const conversation = (conversationId: string, patch: Partial<Conversation> = {}): Conversation => ({
  id: conversationId, title: `会话 ${conversationId}`, titleLocked: false, agent: 'codex',
  workspacePath: '/project', projectPaths: ['/project'], managedWorkspace: false,
  sessionId: 'session', chat: { turn: 'idle' }, createdAt: now, updatedAt: now, ...patch
})

const task = (taskId: string, patch: Partial<Task> = {}): Task => Task.parse({
  id: taskId, title: `任务 ${taskId}`, details: '', status: 'running', agent: 'codex',
  repos: [{ path: '/project', worktreePath: null, branch: null }], dependsOn: [],
  createdAt: now, updatedAt: now, ...patch
})

const run = (runId: string, patch: Partial<ScheduledRun> = {}): ScheduledRun => ({
  id: runId, title: `预约 ${runId}`, agent: 'codex', target: { kind: 'task', taskId: 'scheduled' },
  notBefore: null, resetsAt: null, status: 'waiting', conversationId: null, attempts: 0,
  error: null, createdAt: now, settledAt: null, ...patch
})

const routine = (routineId: string, patch: Partial<Routine> = {}): Routine => ({
  id: routineId, title: `定时 ${routineId}`, enabled: true, schedule: { kind: 'daily', time: '18:00' },
  target: { kind: 'new', agent: 'auto', projectPaths: ['/project'], text: '工作' },
  nextRunAt: at(14, 18), lastFiredAt: null, unread: 0, lastRun: null,
  createdAt: now, updatedAt: now, ...patch
})

const input = (patch: Partial<OverviewInput> = {}): OverviewInput => ({
  tasks: {}, conversations: {}, unseen: {}, routines: [], squadRuns: {}, schedules: [], now, ...patch
})

const request = (open = 1) => ({ kind: 'approval' as const, requestId: 'allow', tool: 'shell', title: '运行测试', open, decisions: ['allow', 'deny'] as const })
const awaiting = (conversationId: string, open = 1, patch: Partial<Conversation> = {}) => conversation(conversationId, {
  chat: { turn: 'awaiting', request: { ...request(open), decisions: [...request().decisions] } }, ...patch
})

function squadFixture() {
  const squad = Squad.parse({ id: id(1), name: '开发队', leaderId: id(2), archivedAt: null,
    createdAt: now, updatedAt: now, members: [
      { id: id(2), name: '队长', agent: 'codex', capability: 'readOnly' },
      { id: id(3), name: '开发', agent: 'codex', capability: 'develop' },
      { id: id(4), name: '审查', agent: 'claude', capability: 'readOnly' }
    ] })
  const leader = awaiting(id(5), 1, { taskId: 'squad-task' })
  const member = awaiting(id(6), 2, { squadRunId: id(7) })
  const squadRun = SquadRun.parse({ id: id(7), taskId: 'squad-task', squad,
    leaderConversationId: leader.id, state: 'running', permissionMode: 'ask', allowBypass: false,
    summary: null, createdAt: now, updatedAt: now, works: [
      { id: id(8), memberId: id(3), conversationId: member.id, instruction: '实现', capability: 'develop',
        state: 'awaiting', result: null, error: null, delivered: false, createdAt: now, updatedAt: now },
      { id: id(9), memberId: id(4), conversationId: id(10), instruction: '审查', capability: 'readOnly',
        state: 'running', result: null, error: null, delivered: false, createdAt: now, updatedAt: now }
    ] })
  const squadTask = task('squad-task', { squadId: squad.id, conversationId: leader.id, awaitingInput: true })
  return { squadRun, squadTask, leader, member }
}

describe('overview mine', () => {
  it('merges the squad task and two waiting members into one row counted twice', () => {
    const { squadRun, squadTask, leader, member } = squadFixture()
    const result = overview(input({ tasks: { [squadTask.id]: squadTask },
      squadRuns: { [squadRun.id]: squadRun }, conversations: { [leader.id]: leader, [member.id]: member },
      unseen: { [leader.id]: true, [member.id]: true } }))
    expect(result.mine).toHaveLength(1)
    expect(result.mine[0]).toMatchObject({ kind: 'squad', key: 'task:squad-task', waits: 2,
      title: squadTask.title, detail: '1 名运行 · 3 项待审批' })
    expect(result.mine[0]?.members?.map((item) => item.conversationId)).toEqual([leader.id, member.id])
    expect(result.counts).toEqual({ mine: 2, running: 0, next: 0, unread: 0 })
  })

  it('counts three requests in one conversation once and keeps the extra requests visible', () => {
    const chat = awaiting(id(1), 3)
    const result = overview(input({ conversations: { [chat.id]: chat }, unseen: { [chat.id]: true } }))
    expect(result.mine).toHaveLength(1)
    expect(result.mine[0]).toMatchObject({ waits: 1, conversationId: chat.id, attention: { request: { open: 3 } } })
    expect(result.mine[0]?.detail).toContain('还有 2 项')
    expect(result.counts.mine).toBe(1)
    expect(result.unread).toEqual([])
  })

  it.each(['status', 'outcome'] as const)('places an unread routine with a failed %s only in mine', (failure) => {
    const lastRun = run(id(2), { target: { kind: 'routine', routineId: id(1) }, status: 'started',
      outcome: 'completed', finishedAt: now, conversationId: id(3), [failure]: 'failed' })
    const rule = routine(id(1), { unread: 2, lastRun })
    const chat = conversation(id(3), { routineId: rule.id, sessionId: null, lastExit: { code: 1, at: now } })
    const result = overview(input({ routines: [rule], schedules: [lastRun],
      conversations: { [chat.id]: chat }, unseen: { [chat.id]: true } }))
    expect(result.mine).toHaveLength(1)
    expect(result.mine[0]).toMatchObject({ kind: 'routine', routineId: rule.id, reason: '运行失败', failed: true, waits: 1 })
    expect(result.unread).toEqual([])
    expect(result.counts).toEqual({ mine: 1, running: 0, next: 0, unread: 0 })
  })

  it('preserves actionable reason priority and puts scheduled failures last', () => {
    const chats = [awaiting(id(1)), conversation(id(2), { sessionId: null, lastExit: { code: 1, at: now } }),
      conversation(id(3), { chat: { turn: 'idle', request: { ...request(), decisions: ['allow'], async: true } } })]
    const data = input({ conversations: Object.fromEntries(chats.map((chat) => [chat.id, chat])),
      tasks: { review: task('review', { status: 'review' }) },
      schedules: [run(id(4), { status: 'failed', createdAt: 0 }), run(id(7), { status: 'failed', settledAt: now - 1 })],
      routines: [routine(id(5), { unread: 1, lastRun: run(id(6), { status: 'failed' }) })] })
    const result = overview(data)
    expect(result.mine.slice(0, 4).map((row) => row.attention)).toEqual(actionableItems(data))
    expect(result.mine.slice(4).map((row) => row.kind)).toEqual(['routine', 'schedule', 'schedule'])
    expect(result.mine.slice(4).map((row) => row.at)).toEqual([now, now - 1, 0])
  })

  it('reports failed user reservations, excluding automatic resumes and routine runs', () => {
    const result = overview(input({ schedules: [run(id(1), { status: 'failed', error: 'missing-repo' }),
      run(id(2), { status: 'failed', target: { kind: 'resume', conversationId: id(3), stageId: 'stage', itemId: 'limit' } }),
      run(id(4), { status: 'failed', target: { kind: 'routine', routineId: id(5) } })] }))
    expect(result.mine).toHaveLength(1)
    expect(result.mine[0]).toMatchObject({ scheduleId: id(1), reason: '没能开始：请先添加项目', failed: true, waits: 1 })
  })

  it('counts a squad awaiting review once when no member is waiting', () => {
    const { squadRun, squadTask } = squadFixture()
    const result = overview(input({ tasks: { [squadTask.id]: { ...squadTask, status: 'review', awaitingInput: false } },
      squadRuns: { [squadRun.id]: squadRun } }))
    expect(result.mine[0]).toMatchObject({ kind: 'squad', waits: 1, members: [], detail: '1 名运行 · 待验收' })
  })
})

describe('overview unread and ownership', () => {
  it('keeps a normally completed conversation only in unread without an action count', () => {
    const chat = conversation(id(1), { sessionId: null, lastExit: { code: 0, at: now } })
    const result = overview(input({ conversations: { [chat.id]: chat }, unseen: { [chat.id]: true, missing: true } }))
    expect(result.unread).toHaveLength(1)
    expect(result.unread[0]).toMatchObject({ kind: 'conversation', waits: 0, conversationId: chat.id })
    expect(result.counts).toEqual({ mine: 0, running: 0, next: 0, unread: 1 })
  })

  it('leaves an archived conversation out of what needs me and of unread', () => {
    const crashed = conversation(id(1), { sessionId: null, lastExit: { code: 1, at: now }, archivedAt: now })
    const finished = conversation(id(2), { sessionId: null, lastExit: { code: 0, at: now }, archivedAt: now })
    const result = overview(input({ conversations: { [crashed.id]: crashed, [finished.id]: finished }, unseen: { [crashed.id]: true, [finished.id]: true } }))
    expect(result.counts).toEqual({ mine: 0, running: 0, next: 0, unread: 0 })
  })

  it('keeps routine unread under its rule with the next time in its detail', () => {
    const rule = routine(id(1), { unread: 3, lastRun: run(id(2), { status: 'started', outcome: 'completed', finishedAt: now, conversationId: id(3) }) })
    const chat = conversation(id(3), { routineId: rule.id })
    const result = overview(input({ routines: [rule], conversations: { [chat.id]: chat }, unseen: { [chat.id]: true } }))
    expect(result.unread).toHaveLength(1)
    expect(result.unread[0]).toMatchObject({ kind: 'routine', routineId: rule.id, detail: '3 次运行未读 · 下次 18:00' })
    expect(result.counts).toEqual({ mine: 0, running: 0, next: 0, unread: 1 })
  })

  it('groups completed task chats under the task and suppresses unread while it is running', () => {
    const chats = [conversation(id(1), { taskId: 'task' }), conversation(id(2), { taskId: 'task', updatedAt: now + 1 })]
    const data = input({ tasks: { task: task('task', { status: 'done' }) },
      conversations: Object.fromEntries(chats.map((chat) => [chat.id, chat])), unseen: { [id(1)]: true, [id(2)]: true } })
    expect(overview(data).unread).toEqual([expect.objectContaining({ key: 'task:task', kind: 'task', conversationId: id(2) })])
    const running = overview({ ...data, tasks: { task: task('task') } })
    expect(running.unread).toEqual([])
    expect(running.running).toHaveLength(1)
  })
})

describe('overview next', () => {
  it('separates a future appointment from quota waits, showing a clock only for resetsAt', () => {
    const result = overview(input({ schedules: [run(id(1), { notBefore: at(14, 17), resetsAt: at(14, 16) }),
      run(id(2), { resetsAt: at(14, 15) }), run(id(3)), run(id(4), { notBefore: at(14, 10) })] }))
    expect(result.next.byTime).toEqual([expect.objectContaining({ scheduleId: id(1), at: at(14, 17), reason: '17:00 之后开始' })])
    expect(result.next.byCondition.map((row) => row.reason)).toEqual([
      '额度恢复后开始', '即将开始（同一个 Agent 的预约依次运行）', '等额度恢复（15:00）'
    ])
    expect(result.counts.next).toBe(4)
  })

  it('uses the actual reset clock even if its timestamp has passed', () => {
    const result = overview(input({ schedules: [run(id(1), { resetsAt: at(14, 11) })] }))
    expect(result.next.byCondition[0]?.reason).toBe('额度恢复后开始（11:00）')
  })

  it('sorts timed runs and enabled routines, placing local tomorrow and later in later', () => {
    const result = overview(input({ now: at(14, 23, 30), schedules: [
      run(id(1), { notBefore: at(16, 1) }), run(id(2), { notBefore: at(14, 23, 59) }),
      run(id(3), { notBefore: at(15, 0) })
    ], routines: [routine(id(4), { nextRunAt: at(14, 23, 45) }), routine(id(5), { nextRunAt: at(15, 9) }),
      routine(id(6), { enabled: false }), routine(id(7), { nextRunAt: null })] }))
    expect(result.next.byTime.map((row) => row.key)).toEqual([`routine:${id(4)}`, `schedule:${id(2)}`])
    expect(result.next.later.map((row) => row.key)).toEqual([`schedule:${id(3)}`, `routine:${id(5)}`, `schedule:${id(1)}`])
    expect(result.counts.next).toBe(5)
  })

  it('shows pending tasks waiting on unfinished dependencies, excluding done and missing dependencies', () => {
    const blocked = task('blocked', { status: 'pending', dependsOn: ['pending', 'review', 'done', 'missing'] })
    const result = overview(input({ tasks: { blocked, pending: task('pending', { status: 'pending' }),
      review: task('review', { status: 'review' }), done: task('done', { status: 'done' }) } }))
    expect(result.next.byCondition).toEqual([expect.objectContaining({ key: 'task:blocked', reason: '等 2 个依赖', detail: '' })])
    expect(result.counts.mine).toBe(1)
    expect(result.counts.next).toBe(1)
  })
})

describe('overview running', () => {
  it('attaches a running routine run to its rule once, including its future schedule', () => {
    const runningRun = run(id(2), { target: { kind: 'routine', routineId: id(1) },
      status: 'started', settledAt: at(14, 11), conversationId: id(3), outcome: null, finishedAt: null })
    const chat = conversation(id(3), { routineId: id(1), chat: { turn: 'running' } })
    const result = overview(input({ schedules: [runningRun], routines: [routine(id(1), { lastRun: runningRun })],
      conversations: { [chat.id]: chat }, unseen: { [chat.id]: true } }))
    expect(result.running).toHaveLength(1)
    expect(result.running[0]).toMatchObject({ kind: 'routine', routineId: id(1), scheduleId: runningRun.id,
      conversationId: chat.id, detail: '11:00 开始，进行中 · 下次 18:00' })
    expect(result.counts).toEqual({ mine: 0, running: 1, next: 0, unread: 0 })
  })

  it('keeps routine approvals on the rule and excludes its active run from running', () => {
    const chat = awaiting(id(3), 2, { routineId: id(1) })
    const active = run(id(2), { target: { kind: 'routine', routineId: id(1) },
      status: 'started', conversationId: chat.id, outcome: null, finishedAt: null, settledAt: now })
    const result = overview(input({ routines: [routine(id(1), { lastRun: active })],
      conversations: { [chat.id]: chat }, schedules: [active] }))
    expect(result.mine[0]).toMatchObject({ kind: 'routine', waits: 1, scheduleId: active.id, attention: { conversationId: chat.id } })
    expect(result.mine[0]?.detail).toContain('还有 1 项')
    expect(result.running).toEqual([])
    expect(result.counts.next).toBe(0)
  })

  it('counts task rows, independent conversations and starting appointments without managed chat duplicates', () => {
    const chats = [conversation(id(1), { taskId: 'task', chat: { turn: 'running' } }),
      conversation(id(2), { chat: { turn: 'running' } }),
      conversation(id(3), { discussionId: id(4), chat: { turn: 'running' } }),
      conversation(id(5), { squadRunId: id(6), chat: { turn: 'running' } })]
    const result = overview(input({ tasks: { task: task('task', { conversationId: id(1) }) },
      conversations: Object.fromEntries(chats.map((chat) => [chat.id, chat])), schedules: [
        run(id(7), { status: 'starting' }), run(id(8), { status: 'started' }), run(id(9), { status: 'cancelled' })
      ] }))
    expect(result.running.map((row) => row.key).sort()).toEqual([`conversation:${id(2)}`, `schedule:${id(7)}`, 'task:task'])
    expect(result.counts.running).toBe(3)
  })

  it('omits the running-member detail while a squad task has no running works', () => {
    const { squadRun, squadTask } = squadFixture()
    const result = overview(input({ tasks: { [squadTask.id]: { ...squadTask, awaitingInput: false } },
      squadRuns: { [squadRun.id]: { ...squadRun, works: [] } } }))
    expect(result.running[0]).toMatchObject({ kind: 'squad', reason: '进行中', detail: '' })
  })

  it('counts running squad members from works once per member and selects the newest run', () => {
    const { squadRun, squadTask } = squadFixture()
    const active = { ...squadRun, works: squadRun.works.map((work) => ({ ...work, state: 'running' as const })) }
    const repeated = active.works[0]
    if (!repeated) throw new Error('fixture has no work')
    active.works.push({ ...repeated, id: id(11) })
    const old = { ...active, id: id(12), createdAt: now - 1, works: [] }
    const result = overview(input({ tasks: { [squadTask.id]: { ...squadTask, awaitingInput: false } },
      squadRuns: { [active.id]: active, [old.id]: old } }))
    expect(result.running[0]).toMatchObject({ kind: 'squad', detail: '2 名运行' })
    expect(result.counts.running).toBe(1)
  })
})

describe('overview limited cores and purity', () => {
  it('does not change task aggregation when a limited core opens its chat', () => {
    const t = task('task', { conversationId: id(1), awaitingInput: true })
    const data = input({ tasks: { task: t }, includeTaskSummaries: false, unseen: { [id(1)]: true } })
    const chat = awaiting(id(1), 3, { taskId: t.id })
    expect(overview({ ...data, conversations: { [chat.id]: chat } })).toEqual(overview(data))
    expect(overview(data).counts.mine).toBe(1)
  })

  it('still groups known squad members without counting a review summary twice', () => {
    const { squadRun, squadTask, member } = squadFixture()
    const result = overview(input({ tasks: { [squadTask.id]: { ...squadTask, status: 'review' } },
      squadRuns: { [squadRun.id]: squadRun }, conversations: { [member.id]: member }, includeTaskSummaries: false }))
    expect(result.mine).toHaveLength(1)
    expect(result.mine[0]).toMatchObject({ waits: 1, members: [expect.objectContaining({ conversationId: member.id })] })
    expect(result.counts.mine).toBe(1)
  })

  it('accepts missing optional collections and leaves input unchanged', () => {
    expect(overview({ tasks: {}, conversations: {}, unseen: {}, now }).counts).toEqual({ mine: 0, running: 0, next: 0, unread: 0 })
    const data = input({ schedules: [run(id(1), { notBefore: at(15, 1) })], routines: [routine(id(2))] })
    const before = structuredClone(data)
    expect(overview(data)).toEqual(overview(data))
    expect(data).toEqual(before)
  })
})

describe('overview head and timeline', () => {
  it('breaks what waits on the user down by kind, counting each squad member', () => {
    const { squadRun, squadTask, leader, member } = squadFixture()
    const question = conversation(id(11), { chat: { turn: 'awaiting', request: { kind: 'question', requestId: 'q', tool: null, title: '选哪个？', decisions: [], open: 1 } } })
    const result = overview(input({ tasks: { [squadTask.id]: squadTask, review: task('review', { status: 'review' }) },
      conversations: { [leader.id]: leader, [member.id]: member, [id(11)]: question }, squadRuns: { [squadRun.id]: squadRun }, schedules: [run(id(12), { status: 'failed' })] }))
    expect(waitBreakdown(result.mine)).toBe('2 等确认 · 1 等回答 · 1 待验收 · 1 异常')
    expect(waitBreakdown([])).toBe('')
  })

  it('puts later rows under tomorrow, then under their date', () => {
    const result = overview(input({ schedules: [run(id(1), { notBefore: at(15, 9) }), run(id(2), { notBefore: at(15, 20) }), run(id(3), { notBefore: at(17, 8) })] }))
    expect(laterByDay(result.next.later, now).map(({ day, rows }) => [day, rows.map((row) => row.scheduleId)])).toEqual([
      ['明天', [id(1), id(2)]], ['10月17日', [id(3)]]
    ])
  })
})

it('keeps helper running turns and stale unread markers out of the overview', () => {
  const helper = conversation(id(99), { helperOf: id(98), chat: { turn: 'running' } })
  const actual = overview(input({ conversations: { [helper.id]: helper }, unseen: { [helper.id]: true } }))
  expect(actual).toEqual(overview(input()))
})
