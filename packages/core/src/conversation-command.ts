import type { AgentKind } from '@conclave/protocol'
import type { AgentCommand } from './agent-command'
import { adapterOf } from './agents'
import type { AgentLaunch } from './agents/agent-adapter'

// The agent speaks JSON lines over stdio: the stream carries every message, and none goes in argv
// (messages, the handoff prompt included, go to stdin).
export function chatCommand(
  agent: AgentKind,
  providerSessionId: string | null,
  resume: boolean,
  handoffPath: string | null,
  extraProjects: readonly string[] = [],
  launch: Omit<AgentLaunch, 'providerSessionId' | 'resume' | 'handoffPath' | 'extraProjects'> = {}
): AgentCommand {
  return adapterOf(agent).command({ providerSessionId, resume, handoffPath, extraProjects, ...launch })
}
