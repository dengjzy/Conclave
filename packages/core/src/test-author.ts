import { randomUUID } from 'node:crypto'
import { agentDescriptor, parseHiddenTestPlan, type HiddenTestPlan, type Task } from '@conclave/protocol'
import type { ConversationService } from './conversation-service'

const TIMEOUT_MS = 180_000

type Chats = Pick<ConversationService, 'create' | 'continue' | 'send' | 'chatPage' | 'messages' | 'stop' | 'waitForTurn'>

// A separate read-only agent reads the task and the repository's test conventions and answers with
// a JSON test plan. It never sees the implementation: the plan is authored while the implement
// conversation runs, and the files exist only when the verifier materializes them.
export class TestAuthorService {
  constructor(private readonly chats: Chats) {}

  // mcpServers: the implement conversation's own user MCP selection, which the reader keeps.
  async author(task: Task, mcpServers: readonly string[] | null = null): Promise<HiddenTestPlan | null> {
    if (!task.conversationId || !task.agent || task.repos.length === 0) return null
    const conversation = await this.chats.create(
      task.agent,
      task.repos.map((repo) => repo.path),
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
      await this.chats.send(conversation.id, prompt(task), [], false, false, `test-author:${task.id}`)
      if (!await this.chats.waitForTurn(conversation.id, started, TIMEOUT_MS)) return null
      const text = this.chats.messages(conversation.id).filter((message) => message.role === 'assistant' && message.complete).at(-1)?.text ?? ''
      return parseHiddenTestPlan(text)
    } catch {
      return null
    } finally {
      await this.chats.stop(conversation.id).catch(() => {})
    }
  }
}

function prompt(task: Task): string {
  return [
    `你是这个任务的测试作者。只读代码，不改任何文件，不提交计划。`,
    `任务：${task.title}`,
    task.details.trim() ? `需求：\n${task.details.trim()}` : '',
    `项目目录（只读）：${task.repos.filter((repo) => !repo.reference).map((repo) => repo.path).join('、')}`,
    '请从需求出发，写一组能证明“做对了”的隐藏验收测试。不要看实现分支；不要写实现代码。',
    '先读仓库现有的测试框架、目录和 fixture，沿用同样的写法。测试要能在实现之前失败，在实现之后通过。',
    '只回复一个 JSON 对象，不要代码块以外的解释。格式：',
    '{"command":"运行这组测试的命令","files":[{"path":"相对项目根的路径","content":"完整文件内容"}],"note":"一句话说明这组测试证明什么"}',
    '最多 20 个文件；路径必须在项目根之内；命令在项目根运行。'
  ].filter(Boolean).join('\n\n')
}
