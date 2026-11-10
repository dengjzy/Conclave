import { randomUUID } from 'node:crypto'
import { agentDescriptor, parseReplan, type Replan, type Task } from '@conclave/protocol'
import type { ConversationService } from './conversation-service'

const TIMEOUT_MS = 120_000

type Chats = Pick<ConversationService, 'create' | 'continue' | 'send' | 'chatPage' | 'messages' | 'stop' | 'waitForTurn'>

// A separate read-only agent looks at the task, the attempts and the newest failure, and proposes
// a different approach. It is a planner, not an implementer: the answer is a diagnosis and an
// instruction, and the implement conversation carries it out.
export class ReplannerService {
  constructor(private readonly chats: Chats) {}

  // mcpServers: the implement conversation's own user MCP selection, which the planner keeps.
  async propose(task: Task, history: string, failure: string, mcpServers: readonly string[] | null = null): Promise<Replan | null> {
    if (!task.conversationId || !task.agent || task.repos.length === 0) return null
    const conversation = await this.chats.create(
      task.agent,
      task.repos.map((repo) => repo.worktreePath ?? repo.path),
      false,
      {
        permissionMode: agentDescriptor(task.agent).readOnlyMode,
        deferStart: true,
        readOnly: true,
        parentId: task.conversationId,
        mcpServers
      },
      null,
      randomUUID()
    )
    try {
      await this.chats.continue(conversation.id, false)
      const started = Date.now()
      await this.chats.send(conversation.id, prompt(task, history, failure), [], false, false, `replan:${task.id}`)
      if (!await this.chats.waitForTurn(conversation.id, started, TIMEOUT_MS)) return null
      const text = this.chats.messages(conversation.id).filter((message) => message.role === 'assistant' && message.complete).at(-1)?.text ?? ''
      return parseReplan(text)
    } catch {
      return null
    } finally {
      await this.chats.stop(conversation.id).catch(() => {})
    }
  }
}

function prompt(task: Task, history: string, failure: string): string {
  return [
    `你是这个任务的重新规划者。只读代码，不改文件，不写实现。`,
    `任务：${task.title}`,
    task.details.trim() ? `需求：\n${task.details.trim()}` : '',
    `项目目录（只读）：${task.repos.filter((repo) => !repo.reference).map((repo) => repo.path).join('、')}`,
    `已经尝试过：\n${history || '（这是第一次失败）'}`,
    `最新的失败：\n${failure}`,
    '请判断上一轮为什么没有通过，并给出一个不同的做法。不要把“再试一次”当方案；不要重复已经证明走不通的改法。',
    '只回复一个 JSON 对象：{"diagnosis":"上一轮为什么失败","instruction":"下一轮具体怎么做，够一个实现 Agent 直接执行","steps":["按顺序的步骤，最多 8 条"]}'
  ].filter(Boolean).join('\n\n')
}
