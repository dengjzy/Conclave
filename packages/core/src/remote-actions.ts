import { agentCallOpen, agentDescriptor, canReuseConversation, isAgentKind, PROTOCOL_VERSION, RemoteOperation, RemotePermissionMode, RemoteTaskSummary, remoteOperations } from '@conclave/protocol'
import type { TaskService } from './task-service'
import type { EnvironmentService } from './environment-check'
import type { RpcHandlers, Connection } from './rpc-server'
import { Rejection } from './rejection'

type RemoteHandlers = Pick<RpcHandlers,
  'system.hello' | 'projects.recent' | 'tasks.get' | 'tasks.create' | 'tasks.start' | 'tasks.resumeChat' | 'tasks.handoff' |
  'conversations.list' | 'conversations.get' | 'conversations.create' | 'conversations.continue' | 'conversations.configuration' |
  'conversations.chatCatalog' | 'conversations.setOption' | 'conversations.stages' | 'conversations.handoff' |
  'agentProfiles.list' | 'agentProfiles.available' | 'agentCalls.list' | 'agentCalls.dispatch' | 'agentCalls.cancel' |
  'conversations.watchChat' | 'conversations.chatItems' | 'conversations.send' | 'conversations.interrupt' | 'conversations.respond'>

export function createRemoteActions(options: {
  tasks: Pick<TaskService, 'list'>
  environment: Pick<EnvironmentService, 'check'>
  handlers: () => RemoteHandlers
}) {
  return async (method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
    const parsed = RemoteOperation.safeParse({ method, params })
    if (!parsed.success) throw new Rejection('remote-operation-not-allowed')
    signal.throwIfAborted()
    const operation = parsed.data
    const handlers = options.handlers()
    // Remote clients poll bounded pages, without joining desktop notification subscriptions.
    const connection: Connection = {
      attached: new Set(), watching: new Set(), browsing: new Set(), wiring: new Set(), usageKinds: new Set(),
      notify() {}, onClose() { return () => {} }
    }
    const requireProjects = async (paths: string[]) => {
      const projects = await handlers['projects.recent']({}, connection)
      signal.throwIfAborted()
      if (paths.some((path) => !projects.includes(path))) throw new Rejection('remote-project-not-registered')
    }
    const requireFeature = async (feature: string) => {
      const hello = await handlers['system.hello']({ protocolVersion: PROTOCOL_VERSION }, connection)
      signal.throwIfAborted()
      if (!hello.features?.includes(feature)) throw new Rejection('remote-capability-unavailable')
    }
    if (operation.method.startsWith('agentProfiles.') || operation.method.startsWith('agentCalls.')) await requireFeature('agent-profiles')
    switch (operation.method) {
      case 'catalog': {
        const [projects, environment, hello] = await Promise.all([
          handlers['projects.recent']({}, connection), options.environment.check(false), handlers['system.hello']({ protocolVersion: PROTOCOL_VERSION }, connection)
        ])
        signal.throwIfAborted()
        const agents = environment.checks.flatMap((check) => {
          if (!isAgentKind(check.tool) || check.status === 'missing') return []
          const descriptor = agentDescriptor(check.tool)
          return [{ id: check.tool, name: descriptor.label,
            permissionModes: RemotePermissionMode.options.filter((mode) => descriptor.modes[mode]),
            ...(descriptor.agentPresets ? { agentPresets: descriptor.agentPresets } : {}) }]
        })
        const delegation = hello.features?.includes('agent-profiles')
        const direct = delegation && hello.features?.includes('direct-agent-calls')
        return {
          projects: projects.slice(0, 100), agents,
          methods: Object.keys(remoteOperations).filter((name) => delegation || (!name.startsWith('agentProfiles.') && !name.startsWith('agentCalls.'))),
          capabilities: ['conversations', 'chat-options', 'handoff', 'projects', 'stages',
            ...(agents.some((agent) => agent.agentPresets) ? ['agent-presets'] : []),
            ...(delegation ? ['delegation'] : []), ...(direct ? ['direct-delegation'] : [])]
        }
      }
      case 'projects.list': {
        const [projects, conversations] = await Promise.all([
          handlers['projects.recent']({}, connection), handlers['conversations.list']({}, connection)
        ])
        signal.throwIfAborted()
        const tasks = options.tasks.list()
        const free = conversations.filter((conversation) => canReuseConversation(conversation) && !conversation.archivedAt)
        return projects.slice(0, 100).map((path) => ({ path, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
          taskCount: tasks.filter((task) => task.repos.some((repo) => repo.path === path)).length,
          conversationCount: free.filter((conversation) => conversation.projectPaths.includes(path)).length }))
      }
      case 'tasks.page': {
        const { offset, limit, filter, query, project } = operation.params
        if (project) await requireProjects([project])
        const search = query.toLowerCase()
        const tasks = options.tasks.list().filter((task) => {
          const matches = filter === 'attention' ? task.awaitingInput : filter === 'running' ? task.status === 'running' : true
          return matches && task.title.toLowerCase().includes(search) && (!project || task.repos.some((repo) => repo.path === project))
        }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        return {
          items: tasks.slice(offset, offset + limit).map((task) => RemoteTaskSummary.parse(task)),
          total: tasks.length,
          nextOffset: offset + limit < tasks.length ? offset + limit : null
        }
      }
      case 'tasks.get': return handlers['tasks.get'](operation.params, connection)
      case 'tasks.create': {
        await requireProjects(operation.params.repos)
        return handlers['tasks.create'](operation.params, connection)
      }
      case 'tasks.start': return handlers['tasks.start']({ ...operation.params, permissionMode: 'ask', allowBypass: false }, connection)
      case 'tasks.resumeChat': return handlers['tasks.resumeChat']({ ...operation.params, allowBypass: false }, connection)
      case 'tasks.handoff': return handlers['tasks.handoff']({ ...operation.params, allowBypass: false }, connection)
      case 'conversations.page': {
        const { offset, limit, filter, query, project, archived } = operation.params
        if (project) await requireProjects([project])
        const all = await handlers['conversations.list']({}, connection)
        signal.throwIfAborted()
        const search = query.toLowerCase()
        const conversations = all.filter((conversation) => {
          const matches = filter === 'attention' ? Boolean(conversation.chat?.request) : filter === 'running' ? conversation.starting || conversation.chat?.turn === 'running' : true
          return canReuseConversation(conversation) && Boolean(conversation.archivedAt) === archived && matches &&
            conversation.title.toLowerCase().includes(search) && (!project || conversation.projectPaths.includes(project))
        }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        return { items: conversations.slice(offset, offset + limit), total: conversations.length, nextOffset: offset + limit < conversations.length ? offset + limit : null }
      }
      case 'conversations.get': return handlers['conversations.get'](operation.params, connection)
      case 'conversations.create': {
        await requireProjects(operation.params.projectPaths)
        if (operation.params.profileId) await requireFeature('agent-profiles')
        const preset = operation.params.agentPreset
        if (preset && !agentDescriptor(operation.params.agent).agentPresets?.options.some((option) => option.id === preset)) throw new Rejection('invalid-agent-preset')
        return handlers['conversations.create']({ ...operation.params, permissionMode: operation.params.permissionMode ?? 'ask', allowBypass: false, deferStart: true }, connection)
      }
      case 'conversations.continue': return handlers['conversations.continue']({ ...operation.params, allowBypass: false }, connection)
      case 'conversations.configuration': return handlers['conversations.configuration'](operation.params, connection)
      case 'conversations.chatCatalog': return handlers['conversations.chatCatalog'](operation.params, connection)
      case 'conversations.setOption': return handlers['conversations.setOption'](operation.params, connection)
      case 'conversations.stages': return (await handlers['conversations.stages'](operation.params, connection)).slice(-200)
      case 'conversations.handoff': return handlers['conversations.handoff']({ ...operation.params, allowBypass: false }, connection)
      case 'agentProfiles.list': return (await handlers['agentProfiles.list'](operation.params, connection)).filter((profile) => profile.archivedAt === null).slice(0, 100)
      case 'agentProfiles.available': return (await handlers['agentProfiles.available'](operation.params, connection)).slice(0, 100)
      case 'agentCalls.list': {
        const calls = await handlers['agentCalls.list'](operation.params, connection)
        // A long-running child stays visible even after many newer calls have completed.
        return calls.sort((a, b) => Number(agentCallOpen(b)) - Number(agentCallOpen(a)) || b.createdAt - a.createdAt)
          .slice(0, 100).sort((a, b) => a.createdAt - b.createdAt)
      }
      case 'agentCalls.dispatch': {
        if (operation.params.target) await requireFeature('direct-agent-calls')
        return handlers['agentCalls.dispatch'](operation.params, connection)
      }
      case 'agentCalls.cancel': return handlers['agentCalls.cancel'](operation.params, connection)
      case 'chat.page': return operation.params.before
        ? handlers['conversations.chatItems']({ id: operation.params.id, before: operation.params.before }, connection)
        : handlers['conversations.watchChat']({ id: operation.params.id }, connection)
      case 'conversations.send': return handlers['conversations.send']({ ...operation.params, queue: true }, connection)
      case 'conversations.interrupt': return handlers['conversations.interrupt'](operation.params, connection)
      case 'conversations.respond': return handlers['conversations.respond'](operation.params, connection)
    }
  }
}
