import { randomUUID } from 'node:crypto'
import { agentDescriptor, parseFlowPlan, type AgentKind, type PlanStep, type Task } from '@conclave/protocol'
import type { ConversationService } from './conversation-service'

const TIMEOUT_MS = 180_000

type Chats = Pick<ConversationService, 'create' | 'continue' | 'send' | 'chatPage' | 'messages' | 'stop' | 'waitForTurn'>

// An agent can take a step only if it has a mode that writes; one that only asks or plans cannot.
function writes(agent: AgentKind): boolean {
  return agentDescriptor(agent).startModes.some((mode) => mode !== 'plan' && mode !== 'readOnly')
}

// A read-only planner decomposes the task before the implementation starts. It sees the task and
// the repository, not the implementation, so the graph is a plan rather than a rationalization.
// The agents it may split the work between are the ones this run can actually start.
export class PlannerService {
  constructor(private readonly chats: Chats) {}

  async plan(task: Task, agents: readonly AgentKind[] = []): Promise<PlanStep[] | null> {
    if (!task.agent || task.repos.length === 0) return null
    const roster = [...new Set([task.agent, ...agents])].filter(writes)
    const conversation = await this.chats.create(
      task.agent,
      task.repos.map((repo) => repo.worktreePath ?? repo.path),
      false,
      {
        permissionMode: agentDescriptor(task.agent).readOnlyMode,
        deferStart: true,
        readOnly: true,
        mcpServers: null
      },
      null,
      randomUUID()
    )
    try {
      await this.chats.continue(conversation.id, false)
      const started = Date.now()
      await this.chats.send(conversation.id, prompt(task, roster), [], false, false, `plan:${task.id}`)
      if (!await this.chats.waitForTurn(conversation.id, started, TIMEOUT_MS)) return null
      const text = this.chats.messages(conversation.id).filter((message) => message.role === 'assistant' && message.complete).at(-1)?.text ?? ''
      const steps = parseFlowPlan(text)?.steps ?? null
      // A planner may name an agent this machine cannot write with; the step falls back to the
      // task's own agent rather than failing the plan.
      return steps?.map((step) => ({ ...step, agent: step.agent && roster.includes(step.agent) ? step.agent : null })) ?? null
    } catch {
      return null
    } finally {
      await this.chats.stop(conversation.id).catch(() => {})
    }
  }
}

function prompt(task: Task, agents: readonly AgentKind[]): string {
  return [
    '你是这个任务的规划者。只读代码，不改文件，不写实现。',
    `任务：${task.title}`,
    task.details.trim() ? `需求：\n${task.details.trim()}` : '',
    `项目目录（只读）：${task.repos.filter((repo) => !repo.reference).map((repo) => repo.path).join('、')}`,
    agents.length > 1
      ? `可以分工的 Agent（每一步只能选一个，也可以都不选）：${agents.map((agent) => `${agent}（${agentDescriptor(agent).label}）`).join('、')}`
      : '',
    '把任务拆成 1 到 5 个按顺序执行的实现步骤。每一步要能独立验收，不要写测试代码。',
    '如果某一步更适合另一个 Agent（例如一个人写界面、另一个写后端），在这一步的 agent 里填它的 id；不确定就不填。',
    '只回复一个 JSON 对象：{"steps":[{"title":"短标题","instruction":"这一步具体做什么，够一个实现 Agent 直接执行","agent":"可选的 Agent id"}]}'
  ].filter(Boolean).join('\n\n')
}
