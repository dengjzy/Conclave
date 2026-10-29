import { describe, expect, it } from 'vitest'
import { Squad, SquadRun, type Conversation } from '@conclave/protocol'
import { clockText, memberProgress, orderedWorks, workHeadline } from './squad-progress'

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const squad = Squad.parse({ id: id(1), name: 'Delivery', leaderId: id(2), archivedAt: null, createdAt: 0, updatedAt: 0, members: [
  { id: id(2), name: '队长', agent: 'claude', capability: 'readOnly' },
  { id: id(3), name: '开发', agent: 'codex', capability: 'develop' },
  { id: id(4), name: '审查', agent: 'cursor', capability: 'readOnly' }
] })
const work = (n: number, memberId: string, state: string, at: number, conversation: number | null = null) =>
  ({ id: id(n), memberId, conversationId: conversation === null ? null : id(conversation), instruction: `\n第 ${n} 项\n细节`, capability: 'develop', state, result: null, error: null, delivered: false, createdAt: at, updatedAt: at + 1 })
const run = SquadRun.parse({ id: id(10), taskId: 'task', squad, leaderConversationId: id(20), state: 'running', permissionMode: 'ask', allowBypass: false, summary: null, createdAt: 0, updatedAt: 0, works: [
  work(30, id(3), 'completed', 100, 21),
  work(31, id(3), 'running', 200, 22),
  work(32, id(4), 'queued', 300),
  work(33, id(4), 'failed', 150, 23)
] })
const conversation = (n: number, chat: Conversation['chat']): Conversation => ({ id: id(n), title: '', titleLocked: true, agent: 'codex', workspacePath: '/w', projectPaths: ['/w'], managedWorkspace: false, sessionId: 's', createdAt: 0, updatedAt: 0, chat })

describe('a squad run at a glance', () => {
  it('says what each member does now: the call its conversation is on, what it asked, or what it waits for', () => {
    const conversations = {
      [id(20)]: conversation(20, { turn: 'awaiting', request: { requestId: 'r', kind: 'approval', tool: 'Bash', title: 'git push', decisions: ['allow'], open: 1 } }),
      [id(22)]: conversation(22, { turn: 'running', doing: { tool: 'Bash', title: 'pnpm test' } })
    }
    expect(memberProgress(run, conversations).map(({ member, state, detail, conversationId, since }) => ({ name: member.name, state, detail, conversationId, since }))).toEqual([
      { name: '队长', state: 'awaiting', detail: 'git push', conversationId: id(20), since: null },
      { name: '开发', state: 'running', detail: '命令 pnpm test', conversationId: id(22), since: 201 },
      { name: '审查', state: 'queued', detail: '第 32 项', conversationId: id(23), since: null }
    ])
  })

  it('falls back on the work itself before its conversation says anything, and waits on members as leader', () => {
    const [leader, developer] = memberProgress(run, {})
    expect(leader).toMatchObject({ state: 'idle', detail: '等成员交付' })
    expect(developer).toMatchObject({ state: 'running', detail: '第 31 项' })
    const ended = memberProgress({ ...run, state: 'review' }, {})
    expect(ended.map((member) => member.state)).toEqual(['idle', 'running', 'idle'])
  })

  it('puts what goes on first, then what ended, the latest first', () => {
    const { open, ended } = orderedWorks(run.works)
    expect(open.map((each) => each.id)).toEqual([id(31), id(32)])
    expect(ended.map((each) => each.id)).toEqual([id(33), id(30)])
  })

  it('reads an instruction as its first line, without Markdown marks', () => {
    expect(workHeadline('\n## 第 1 步：实现 `overview.ts` 和 **测试**\n细节')).toBe('第 1 步：实现 overview.ts 和 测试')
    expect(workHeadline('读 dashboard-*.ts 和 snake_case 的名字')).toBe('读 dashboard-*.ts 和 snake_case 的名字')
  })

  it('reads a running clock as m:ss, then h:mm:ss', () => {
    expect(clockText(192_000)).toBe('3:12')
    expect(clockText(3_725_000)).toBe('1:02:05')
    expect(clockText(-5)).toBe('0:00')
  })
})
