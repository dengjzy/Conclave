import type { RpcMethod, RpcNotificationName } from './rpc'

// Workspace reads and subscriptions; writes keep the existing mobile control boundary.
export const REMOTE_DESKTOP_METHODS = [
  'agentProfiles.list', 'agentProfiles.available', 'agentCalls.list', 'agentCalls.dispatch',
  'agentCalls.cancel', 'squads.list', 'squads.activeRuns', 'squads.runs',
  'squads.roster', 'git.status', 'git.history',
  'git.containing', 'git.compare', 'git.outgoing',
  'system.hello', 'support.starStatus',
  'system.chatSettings',
  'modelProviders.list', 'accounts.list', 'system.environment',
  'system.agentCliStatus', 'fs.listDirectories', 'fs.validatePath', 'tasks.list',
  'tasks.get', 'tasks.create', 'tasks.startOptions', 'tasks.start',
  'tasks.resumeChat', 'tasks.handoff', 'tasks.branches', 'tasks.changes',
  'conversations.list', 'conversations.get', 'conversations.configuration',
  'conversations.helper', 'conversations.create', 'conversations.chatCatalog', 'todos.list', 'todos.open',
  'conversations.continue', 'conversations.handoff', 'conversations.send', 'conversations.setOption',
  'conversations.interrupt', 'conversations.respond', 'conversations.watchChat', 'conversations.unwatchChat',
  'conversations.chatItems', 'conversations.messages', 'conversations.stages', 'conversations.branches',
  'conversations.branchOptions', 'projects.branches', 'conversations.changes',
  'conversations.search', 'attachments.stat', 'ports.list',
  'terminals.list',
  'projects.recent',
  'worktrees.list',
  'repos.recent', 'usage.list', 'usage.history', 'usage.forecasts',
  'agents.stats', 'agents.conversationStats', 'dashboard.stats', 'schedules.list',
  'routines.list', 'routines.runs', 'discussions.list', 'discussions.get',
  'discussions.posts', 'sources.list', 'sources.inbox',
] as const satisfies readonly RpcMethod[]

export const REMOTE_DESKTOP_WRITE_METHODS = [
  'tasks.create', 'tasks.start', 'tasks.resumeChat', 'tasks.handoff',
  'conversations.create', 'conversations.continue', 'conversations.setOption', 'conversations.handoff',
  'agentCalls.dispatch', 'agentCalls.cancel', 'conversations.send', 'conversations.interrupt',
  'conversations.respond',
] as const satisfies readonly RpcMethod[]

export const REMOTE_DESKTOP_NOTIFICATIONS = [
  'git.changed', 'modelProviders.changed', 'accounts.changed', 'system.agentCliChanged',
  'system.environmentChanged', 'schedules.changed', 'routines.changed', 'agentProfiles.changed',
  'agentCalls.changed', 'squads.changed', 'squads.runChanged', 'discussions.changed',
  'discussions.deleted', 'discussions.posts', 'conversations.changed', 'conversations.deleted',
  'todos.changed', 'conversations.chatItems', 'conversations.chatDelta', 'tasks.changed',
  'tasks.deleted', 'usage.changed',
  'terminals.changed',
  'worktrees.changed', 'sources.listChanged', 'sources.inboxChanged',
] as const satisfies readonly RpcNotificationName[]

export const REMOTE_DESKTOP_FEATURES = [
  'chat-options', 'task-start', 'conversation-branches',
  'usage-limit', 'agent-stats', 'conversation-stats', 'environment',
  'plan-modes', 'dashboard', 'task-conversation-summaries',
  'conversation-configuration', 'deferred-conversation-start', 'git-commit-branches',
  'task-handoff', 'handoff-model', 'handoff-mode', 'todo-overview',
  'agent-profiles', 'direct-agent-calls',
] as const satisfies readonly string[]

export function isRemoteDesktopMethod(method: string): method is typeof REMOTE_DESKTOP_METHODS[number] {
  return REMOTE_DESKTOP_METHODS.some((allowed) => allowed === method)
}
