import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AGENT_KINDS, AgentCliStatus, initialAgentCliStatus, type AgentKind, type AgentCliUpgrade, Environment } from '@conclave/protocol'
import type { SessionInfo } from '@conclave/protocol/node'
import { agentCliAccess } from './agent-cli-access'
import { cliCommandText, compareCliVersions, latestCliVersion, resolveCliTarget, type CliTarget } from './agent-cli-target'
import type { SessionHost } from './daemon-client'
import type { EnvironmentService } from './environment-check'
import type { TerminalService } from './terminal-service'
import { Rejection } from './rejection'

const Operation = z.object({
  status: AgentCliStatus,
  id: z.string().uuid(),
  before: z.string().nullable(),
  target: z.string().nullable(),
  command: z.string(),
  sessionId: z.string().nullable(),
  environment: Environment
})
type Operation = z.infer<typeof Operation>
type Dependencies = {
  environment: Pick<EnvironmentService, 'check'>
  daemon: SessionHost
  terminals: Pick<TerminalService, 'upgradeCli' | 'adoptUpgrade' | 'list'>
  changed(status: AgentCliStatus): void
  invalidate(agent: AgentKind): void | Promise<void>
  resolve?: typeof resolveCliTarget
  latest?: typeof latestCliVersion
  now?: () => number
}

export class AgentCliMaintenance {
  private readonly db: DatabaseSync
  private readonly statuses = new Map<AgentKind, AgentCliStatus>()
  private readonly targets = new Map<AgentKind, CliTarget>()
  private readonly checks = new Map<AgentKind, Promise<AgentCliStatus>>()
  private readonly operations = new Map<AgentKind, Operation>()
  private readonly releases = new Map<AgentKind, () => void>()
  private readonly finishing = new Set<AgentKind>()
  private pendingAgent: AgentKind | null = null
  private readonly cancelled = new Set<AgentKind>()
  private pending: Promise<AgentCliUpgrade> | null = null
  private readonly timer: ReturnType<typeof setInterval>
  private readonly now: () => number

  constructor(file: string, private readonly deps: Dependencies) {
    this.db = new DatabaseSync(file)
    this.now = deps.now ?? Date.now
    for (const row of this.db.prepare('SELECT data FROM agent_cli_operations').all()) {
      if (typeof row.data !== 'string') continue
      try {
        const operation = Operation.parse(JSON.parse(row.data))
        this.statuses.set(operation.status.agent, operation.status)
        if (['starting', 'running'].includes(operation.status.phase)) {
          this.operations.set(operation.status.agent, operation)
          this.releases.set(operation.status.agent, agentCliAccess.reserve(operation.status.agent))
        }
      } catch { /* A malformed historic result must not prevent core from starting. */ }
    }
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}) }, 1000)
    this.timer.unref()
  }

  close(): void {
    clearInterval(this.timer)
    for (const release of this.releases.values()) release()
    this.db.close()
  }

  private status(agent: AgentKind): AgentCliStatus { return this.statuses.get(agent) ?? initialAgentCliStatus(agent) }
  private update(agent: AgentKind, fields: Partial<AgentCliStatus>): AgentCliStatus {
    const status = { ...this.status(agent), ...fields, revision: this.status(agent).revision + 1 }
    this.statuses.set(agent, status)
    const operation = this.operations.get(agent)
    if (operation) { operation.status = status; this.save(operation) }
    this.deps.changed(status)
    return status
  }
  private save(operation: Operation): void {
    this.db.prepare('INSERT INTO agent_cli_operations (agent, data) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET data = excluded.data')
      .run(operation.status.agent, JSON.stringify(operation))
  }

  async list(agent?: AgentKind, refresh = false): Promise<AgentCliStatus[]> {
    await this.reconcile()
    const kinds = agent ? [agent] : AGENT_KINDS
    await Promise.all(kinds.map((kind) => this.check(kind, refresh)))
    return kinds.map((kind) => this.status(kind))
  }

  private check(agent: AgentKind, refresh: boolean): Promise<AgentCliStatus> {
    if (this.operations.has(agent) || this.pendingAgent === agent) return Promise.resolve(this.status(agent))
    const pending = this.checks.get(agent)
    if (pending) return pending
    const status = this.status(agent)
    const ttl = status.error || status.availability === 'unknown' ? 5 * 60_000 : 60 * 60_000
    if (!refresh && status.checkedAt !== null && this.now() - status.checkedAt < ttl) return Promise.resolve(status)
    const promise = (async () => {
      this.update(agent, { phase: 'checking', error: null, blockers: [] })
      try {
        const environment = await this.deps.environment.check(refresh)
        const target = await agentCliAccess.use(agent, () => (this.deps.resolve ?? resolveCliTarget)(agent, environment))
        if (!target) return this.update(agent, { ...initialAgentCliStatus(agent), availability: 'missing', checkedAt: this.now() })
        this.targets.set(agent, target)
        let latest: string | null = null
        let error: string | null = null
        try { latest = await (this.deps.latest ?? latestCliVersion)(target) } catch { error = 'agent-cli-network' }
        let supported = false
        try { supported = (await this.deps.daemon.request('info', {})).features?.includes('agent-cli-maintenance') ?? false; if (!supported) error ??= 'agent-cli-daemon-outdated' } catch { error ??= 'daemon-unavailable' }
        const comparison = latest && target.version ? compareCliVersions(target.version, latest) : null
        return this.update(agent, {
          currentVersion: target.version, latestVersion: latest, path: target.path, channel: target.channel,
          canUpgrade: supported && target.command !== null && target.version !== null,
          availability: comparison !== null ? comparison < 0 ? 'available' : 'current' : target.channel === 'native' || target.channel === 'desktop' ? 'managed' : 'unknown',
          phase: 'idle', error, checkedAt: this.now(), upgradeCommand: target.command && cliCommandText(target.command)
        })
      } catch (error) {
        return this.update(agent, { phase: 'error', error: reason(error), checkedAt: this.now() })
      }
    })().finally(() => this.checks.delete(agent))
    this.checks.set(agent, promise)
    return promise
  }

  upgrade(agent: AgentKind): Promise<AgentCliUpgrade> {
    if (this.pending) return this.pendingAgent === agent ? this.pending : Promise.resolve({ status: { ...this.status(agent), error: 'agent-cli-maintenance-running' }, terminal: null })
    const operation = this.operations.get(agent)
    if (operation) return Promise.resolve({ status: this.status(agent), terminal: this.deps.terminals.list().find((each) => each.id === operation.id) ?? null })
    this.pendingAgent = agent
    this.cancelled.delete(agent)
    this.pending = this.start(agent).finally(() => { this.pending = null; this.pendingAgent = null })
    return this.pending
  }

  private async start(agent: AgentKind): Promise<AgentCliUpgrade> {
    let release: (() => void) | undefined
    try {
      await this.checks.get(agent)
      if (!(await this.deps.daemon.request('info', {})).features?.includes('agent-cli-maintenance')) throw new Rejection('agent-cli-daemon-outdated')
      const environment = await this.deps.environment.check(true)
      release = agentCliAccess.reserve(agent)
      const { sessions } = await this.deps.daemon.request('list', {})
      const blockers = sessions.filter((session) => !session.exited && (session.agent === agent || (!session.agent && session.io === 'pipe')))
      if (blockers.length) {
        this.update(agent, { blockers: blockers.map((session) => session.sessionId) })
        throw new Rejection('agent-cli-active')
      }
      const operation: Operation = {
        id: randomUUID(), before: null, target: null, command: '', sessionId: null, environment,
        status: { ...this.status(agent), phase: 'starting', terminalId: null, error: null, blockers: [] }
      }
      this.operations.set(agent, operation)
      this.releases.set(agent, release)
      release = undefined
      this.update(agent, operation.status)
      const target = await (this.deps.resolve ?? resolveCliTarget)(agent, environment)
      const checked = this.targets.get(agent)
      if (checked && checked.identity !== target?.identity) throw new Rejection('agent-cli-target-changed')
      if (!target?.command || !target.version) throw new Rejection('agent-cli-source-unknown')
      this.targets.set(agent, target)
      const latest = await (this.deps.latest ?? latestCliVersion)(target).catch(() => null)
      if (target.latestUrl && !latest) throw new Rejection('agent-cli-network')
      const current = latest ? compareCliVersions(target.version, latest) : null
      if (current !== null && current >= 0) {
        const status = this.update(agent, { phase: 'unchanged', currentVersion: target.version, latestVersion: latest, availability: 'current', error: 'agent-cli-version-unchanged' })
        this.release(agent)
        return { status, terminal: null }
      }
      if (this.cancelled.has(agent)) throw new Rejection('agent-cli-cancelled')
      operation.before = target.version
      operation.target = latest
      operation.command = [target.command.command, ...target.command.args].join(' ')
      this.update(agent, { currentVersion: target.version, latestVersion: latest, path: target.path, channel: target.channel })
      const terminal = await this.deps.terminals.upgradeCli(agent, operation.id, target.command)
      operation.sessionId = terminal.sessionId
      if (this.cancelled.has(agent)) await this.deps.daemon.request('kill', { sessionId: terminal.sessionId })
      const status = this.update(agent, { phase: 'running', terminalId: terminal.id })
      return { status, terminal }
    } catch (error) {
      release?.()
      // A disconnected reply does not prove spawn failed: recover by operation id on reconnect.
      if (this.operations.has(agent) && reason(error) === 'daemon-unavailable') {
        return { status: this.update(agent, { error: 'daemon-unavailable' }), terminal: null }
      }
      const status = this.update(agent, { phase: reason(error) === 'agent-cli-cancelled' ? 'cancelled' : 'error', error: reason(error) })
      this.release(agent)
      return { status, terminal: null }
    }
  }

  async cancel(agent: AgentKind): Promise<AgentCliStatus> {
    this.cancelled.add(agent)
    const operation = this.operations.get(agent)
    if (operation?.sessionId) await this.deps.daemon.request('kill', { sessionId: operation.sessionId })
    await this.reconcile()
    return this.status(agent)
  }

  async reconcile(known?: readonly SessionInfo[]): Promise<void> {
    if (!this.operations.size || this.pending) return
    const sessions = known ?? (await this.deps.daemon.request('list', {})).sessions
    await Promise.all([...this.operations].map(async ([agent, operation]) => {
      if (this.finishing.has(agent)) return
      const session = sessions.find((each) => each.upgradeId === operation.id)
      if (!session) {
        this.update(agent, { phase: 'error', error: 'agent-cli-interrupted' })
        this.release(agent)
        return
      }
      this.finishing.add(agent)
      try {
        operation.sessionId = session.sessionId
        // Rebuild a tab if core died between daemon spawn and terminal persistence. A deliberately
        // closed tab stays closed; the operation still follows the daemon until its actual exit.
        if (!operation.status.terminalId) {
          await this.deps.terminals.adoptUpgrade(agent, operation.id, session.sessionId, operation.command)
          this.update(agent, { terminalId: operation.id, phase: 'running', error: null })
        }
        if (!session.exited) return
        const after = await (this.deps.resolve ?? resolveCliTarget)(agent, operation.environment).catch(() => null)
        const comparison = after?.version && operation.before ? compareCliVersions(after.version, operation.before) : null
        const reached = after?.version && operation.target ? compareCliVersions(after.version, operation.target) : null
        let phase: AgentCliStatus['phase'] = 'error'
        let error: string | null = null
        if (session.stopReason) { phase = session.stopReason === 'cancelled' ? 'cancelled' : 'error'; error = session.stopReason === 'cancelled' ? 'agent-cli-cancelled' : 'agent-cli-timed-out' }
        else if (session.exitCode !== 0) error = 'agent-cli-command-failed'
        else if (!after?.version || comparison === null) error = 'agent-cli-version-unverified'
        else if (comparison > 0 && (!operation.target || (reached !== null && reached >= 0))) phase = 'succeeded'
        else if (comparison === 0) { phase = 'unchanged'; error = 'agent-cli-version-unchanged' }
        else error = 'agent-cli-target-not-reached'
        this.update(agent, { currentVersion: after?.version ?? null, phase, error, checkedAt: this.now(), availability: phase === 'succeeded' && operation.target ? 'current' : this.status(agent).availability })
        this.release(agent)
        await this.deps.invalidate(agent)
        await this.deps.environment.check(true).catch(() => {})
      } finally { this.finishing.delete(agent) }
    }))
  }

  private release(agent: AgentKind): void {
    this.operations.delete(agent)
    this.releases.get(agent)?.()
    this.releases.delete(agent)
  }
}
function reason(error: unknown): string {
  return error instanceof Rejection ? error.reason : error instanceof Error && /^agent-cli-/.test(error.message) ? error.message : 'agent-cli-command-failed'
}
