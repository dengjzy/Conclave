import type { AgentKind, ChatDecision, Terminal, TerminalRun } from '@conclave/protocol'
import { adapterOf } from './agents'

// How long a run waits on the user's answer before telling the agent to try again once they have:
// a tool call that hangs longer may be dropped by the agent's own timeout.
export const TERMINAL_DECISION_WAIT_MS = 20_000

type Target = { agent: AgentKind; cwd: string }

// Runs an agent's command in a terminal of its own, once the user lets it. An agent that asks for
// MCP tools itself (Claude Code, under whatever mode the user set) has its runs go straight
// through; for one that asks nothing (Codex), Conclave asks in the chat: this once, or every run in
// the conversation.
export class AgentTerminals {
  private readonly allowed = new Set<string>()
  private readonly allowOnce = new Map<string, Set<string>>()

  constructor(
    private readonly target: (conversationId: string) => Target,
    private readonly start: (conversationId: string, cwd: string, command: string) => Promise<Terminal>,
    private readonly ask: (conversationId: string, command: string, cwd: string) => Promise<ChatDecision>,
    private readonly waitMs = TERMINAL_DECISION_WAIT_MS
  ) {}

  async run(conversationId: string, command: string, cwd?: string): Promise<TerminalRun> {
    const target = this.target(conversationId)
    const folder = cwd?.trim() || target.cwd
    if (adapterOf(target.agent).mcpApproval === 'conclave' && !this.allowed.has(conversationId) && !this.takeOnce(conversationId, command)) {
      // An answer that comes after the wait still counts, for the agent's next try.
      const asked = Promise.resolve().then(() => this.ask(conversationId, command, folder)).then(
        (decision) => {
          if (decision === 'allowForSession') this.allowed.add(conversationId)
          else if (decision === 'allow') this.remember(conversationId, command)
          return decision
        },
        (): ChatDecision => 'deny'
      )
      const decision = await Promise.race([asked, new Promise<null>((resolve) => setTimeout(() => resolve(null), this.waitMs).unref())])
      if (decision === null) return { outcome: 'awaiting' }
      if (decision === 'deny') return { outcome: 'denied' }
      if (decision === 'allow') this.takeOnce(conversationId, command)
    }
    return { outcome: 'started', terminal: await this.start(conversationId, folder, command) }
  }

  private remember(conversationId: string, command: string): void {
    const commands = this.allowOnce.get(conversationId) ?? new Set<string>()
    commands.add(command)
    this.allowOnce.set(conversationId, commands)
  }

  // A one-time yes, spent by the run it was given for.
  private takeOnce(conversationId: string, command: string): boolean {
    return this.allowOnce.get(conversationId)?.delete(command) ?? false
  }
}
