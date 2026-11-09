import { describe, expect, it } from 'vitest'
import type { Conversation, ConversationMessage } from '@conclave/protocol'
import { buildForkRecord, buildHandoff } from './conversation-handoff'

const conversation = {
  title: 'Add a filter',
  managedWorkspace: false,
  projectPaths: ['/repo'],
  workspacePath: '/repo'
} as unknown as Conversation

const messages: ConversationMessage[] = [
  { sequence: 1, conversationId: 'c', stageId: 's', role: 'user', agent: 'dsh', text: 'filter the list', eventKey: 'e1', complete: true, createdAt: 1 },
  { sequence: 2, conversationId: 'c', stageId: 's', role: 'assistant', agent: 'dsh', text: 'done', eventKey: 'e2', complete: true, createdAt: 2 }
]

describe('conversation seeds', () => {
  it('hands another agent the chat and the note, and says whose conclusions to distrust', () => {
    const file = buildHandoff(conversation, messages, 'pick up here', 'claude', 'codex', new Date(0))
    expect(file).toContain('# Conclave 会话移交')
    expect(file).toContain('移交：claude → codex')
    expect(file).toContain('pick up here')
    expect(file).toContain('### #2 assistant · dsh')
    expect(file).toContain('前一个 agent 的结论需要独立验证')
  })

  it("gives a fork the agent's own record, framed as its own work rather than a handoff", () => {
    const file = buildForkRecord(conversation, messages, 'dsh', new Date(0))
    expect(file).toContain('# Conclave 会话分叉')
    expect(file).toContain('分叉：dsh 的同一个会话')
    expect(file).toContain('### #1 user · dsh')
    expect(file).toContain('不要重做记录里已经完成的部分')
    // Nothing was handed over: no heading, no distrust line, and no "→".
    expect(file).not.toContain('移交')
    expect(file).not.toContain('→')
    expect(file).not.toContain('前一个 agent')
  })

  it('says so when there is no message to carry over', () => {
    expect(buildForkRecord(conversation, [], 'dsh')).toContain('（暂无结构化消息）')
    expect(buildHandoff(conversation, [], '', 'claude', 'codex')).toContain('（暂无结构化消息）')
  })
})
