import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCliStatus, Environment, Terminal } from '@conclave/protocol'
import { daemonSchemas, type SessionInfo } from '@conclave/protocol/node'
import { AgentCliMaintenance } from './agent-cli-maintenance'
import { agentCliAccess } from './agent-cli-access'
import type { SessionHost } from './daemon-client'
import { Rejection } from './rejection'
import { TaskStore } from './task-store'
import type { CliTarget } from './agent-cli-target'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-cli-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'test.db')
  new TaskStore(file).close()
  const sessions: SessionInfo[] = []
  const terminals: Terminal[] = []
  const environment: Environment = { checks: [{ tool: 'codex', status: 'ok', path: '/bin/codex', version: '1.0.0', signedIn: true }], searchPath: [], checkedAt: 1 }
  let target: CliTarget = { path: '/bin/codex', identity: 'original', version: '1.0.0', channel: 'npm', command: { command: 'npm', args: ['install', '-g', '@openai/codex@latest'] }, latestUrl: 'https://registry.npmjs.org/@openai/codex/latest' }
  let now = 1
  let supported = true
  const changed: AgentCliStatus[] = []
  const daemon: SessionHost = {
    async request(method, params) {
      let result: unknown
      if (method === 'info') result = { version: 'test', pid: 1, features: supported ? ['agent-cli-maintenance'] : [] }
      else if (method === 'list') result = { sessions }
      else if (method === 'kill') { const ref = daemonSchemas.kill.params.parse(params); const session = sessions.find((each) => each.sessionId === ref.sessionId); if (session) { session.exited = true; session.exitCode = 143; session.stopReason = 'cancelled' }; result = { ok: true } }
      else throw new Error(`unexpected ${method}`)
      return daemonSchemas[method].result.parse(result)
    },
    onEvent: () => () => {}
  }
  const deps = {
    daemon, environment: { check: vi.fn(async () => environment) }, changed: (status: AgentCliStatus) => changed.push(status), invalidate: vi.fn(), now: () => now,
    resolve: vi.fn(async () => target), latest: vi.fn(async () => '2.0.0'),
    terminals: {
      list: () => terminals,
      upgradeCli: vi.fn(async (agent: 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi', id: string) => {
        sessions.push({ sessionId: 'upgrade', exited: false, exitCode: null, io: 'pty', agent, upgradeId: id })
        const terminal: Terminal = { id, sessionId: 'upgrade', cwd: dir, title: 'upgrade', createdAt: 1, command: 'npm install', exited: false }
        terminals.push(terminal)
        return terminal
      }),
      adoptUpgrade: vi.fn(async () => { const terminal = terminals[0]; if (!terminal) throw new Error('missing tab'); return terminal })
    }
  }
  const service = new AgentCliMaintenance(file, deps)
  cleanups.push(() => service.close())
  return { service, deps, sessions, terminals, changed, restart: () => {
    service.close(); cleanups.pop()
    const restarted = new AgentCliMaintenance(file, deps)
    cleanups.push(() => restarted.close())
    return restarted
  }, version: (version: string | null) => { target = { ...target, version } }, identity: () => { target = { ...target, identity: 'replacement' } }, time: (time: number) => { now = time }, oldDaemon: () => { supported = false } }
}

describe('CLI maintenance lifecycle', () => {
  it('coalesces checks, caches successful results, and bypasses cache when asked', async () => {
    const { service, deps, time } = setup()
    await Promise.all([service.list('codex'), service.list('codex')])
    expect(deps.latest).toHaveBeenCalledTimes(1)
    expect((await service.list('codex'))[0]).toMatchObject({ availability: 'available', upgradeCommand: 'npm install -g @openai/codex@latest' })
    time(60 * 60_000 + 2)
    await service.list('codex')
    await service.list('codex', true)
    expect(deps.latest).toHaveBeenCalledTimes(3)
  })

  it('never reports an unavailable release feed as current', async () => {
    const { service, deps, time } = setup()
    deps.latest.mockRejectedValue(new Error('offline'))
    expect((await service.list('codex'))[0]).toMatchObject({ availability: 'unknown', error: 'agent-cli-network' })
    time(5 * 60_000 + 2)
    await service.list('codex')
    expect(deps.latest).toHaveBeenCalledTimes(2)
    expect((await service.upgrade('codex')).terminal).toBeNull()
    expect(deps.terminals.upgradeCli).not.toHaveBeenCalled()
  })

  it('blocks idle live processes and provides their session ids without spawning', async () => {
    const { service, sessions, deps } = setup()
    sessions.push({ sessionId: 'idle-chat', agent: 'codex', io: 'pipe', exited: false, exitCode: null })
    expect((await service.upgrade('codex')).status).toMatchObject({ error: 'agent-cli-active', blockers: ['idle-chat'] })
    expect(deps.terminals.upgradeCli).not.toHaveBeenCalled()
  })

  it('deduplicates clients, blocks new calls only for the upgraded agent, and verifies the new version', async () => {
    const { service, sessions, deps, version } = setup()
    const [first, second] = await Promise.all([service.upgrade('codex'), service.upgrade('codex')])
    expect(first.terminal?.id).toBe(second.terminal?.id)
    expect(deps.terminals.upgradeCli).toHaveBeenCalledTimes(1)
    await expect(agentCliAccess.use('codex', async () => {})).rejects.toMatchObject({ reason: 'agent-cli-maintenance-running' })
    await expect(agentCliAccess.use('claude', async () => 'works')).resolves.toBe('works')
    const session = sessions[0]!
    session.exited = true; session.exitCode = 0
    version('2.0.0')
    await service.reconcile()
    expect((await service.list('codex'))[0]).toMatchObject({ phase: 'succeeded', currentVersion: '2.0.0', availability: 'current' })
    expect(deps.invalidate).toHaveBeenCalledWith('codex')
    expect(agentCliAccess.blocked('codex')).toBe(false)
  })

  it.each([['1.0.0', 0, 'unchanged'], [null, 0, 'error'], ['2.0.0', 1, 'error'], ['1.5.0', 0, 'error'], ['0.9.0', 0, 'error']] as const)('does not call %s with exit %s a successful upgrade', async (after, exitCode, phase) => {
    const { service, sessions, version } = setup()
    await service.upgrade('codex')
    version(after)
    sessions[0]!.exited = true; sessions[0]!.exitCode = exitCode
    await service.reconcile()
    expect((await service.list('codex'))[0]?.phase).toBe(phase)
  })

  it('checks identity again, refuses downgrades, and does not spawn against an old daemon', async () => {
    const first = setup()
    await first.service.list('codex')
    first.identity()
    expect((await first.service.upgrade('codex')).status.error).toBe('agent-cli-target-changed')
    first.version('3.0.0')
    await first.service.list('codex', true)
    expect((await first.service.upgrade('codex')).status.phase).toBe('unchanged')
    first.oldDaemon()
    expect((await first.service.list('codex', true))[0]).toMatchObject({ canUpgrade: false, error: 'agent-cli-daemon-outdated' })
    expect((await first.service.upgrade('codex')).status.error).toBe('agent-cli-daemon-outdated')
    expect(first.deps.terminals.upgradeCli).not.toHaveBeenCalled()
  })

  it('restores a running upgrade after core restarts, and supports cancellation', async () => {
    const { service, restart, deps } = setup()
    const started = await service.upgrade('codex')
    const recovered = restart()
    expect((await recovered.list('codex'))[0]).toMatchObject({ phase: 'running', terminalId: started.terminal?.id })
    expect(deps.terminals.upgradeCli).toHaveBeenCalledTimes(1)
    expect(await recovered.cancel('codex')).toMatchObject({ phase: 'cancelled' })
    expect(agentCliAccess.blocked('codex')).toBe(false)
  })

  it('recovers a daemon spawn whose acknowledgement was lost before core saved the session id', async () => {
    const { service, deps, restart } = setup()
    const spawn = deps.terminals.upgradeCli.getMockImplementation()
    if (!spawn) throw new Error('missing spawn')
    deps.terminals.upgradeCli.mockImplementationOnce(async (agent, id) => {
      await spawn(agent, id)
      throw new Rejection('daemon-unavailable')
    })
    expect((await service.upgrade('codex')).terminal).toBeNull()
    const recovered = restart()
    expect((await recovered.list('codex'))[0]).toMatchObject({ phase: 'running' })
    expect(deps.terminals.adoptUpgrade).toHaveBeenCalledOnce()
    expect(deps.terminals.upgradeCli).toHaveBeenCalledOnce()
  })

  it('cancels during preflight before an installer can start', async () => {
    const { service, deps } = setup()
    const resolve = deps.resolve.getMockImplementation()
    if (!resolve) throw new Error('missing resolver')
    let resume: () => void = () => {}
    deps.resolve.mockImplementationOnce(() => new Promise((done) => { resume = () => { void resolve().then(done) } }))
    const upgrade = service.upgrade('codex')
    await vi.waitFor(() => expect(deps.resolve).toHaveBeenCalledOnce())
    await service.cancel('codex')
    resume()
    expect((await upgrade).status.phase).toBe('cancelled')
    expect(deps.terminals.upgradeCli).not.toHaveBeenCalled()
    expect(agentCliAccess.blocked('codex')).toBe(false)
  })

  it('does not return another agent’s terminal when different agents are upgraded concurrently', async () => {
    const { service, deps } = setup()
    const [first, second] = await Promise.all([service.upgrade('codex'), service.upgrade('claude')])
    expect(first.terminal).not.toBeNull()
    expect(second).toMatchObject({ terminal: null, status: { agent: 'claude', error: 'agent-cli-maintenance-running' } })
    expect(deps.terminals.upgradeCli).toHaveBeenCalledOnce()
  })

  it('respects short-lived core calls at admission', async () => {
    const { service, deps } = setup()
    let finish: () => void = () => {}
    const call = agentCliAccess.use('codex', () => new Promise<void>((resolve) => { finish = resolve }))
    expect((await service.upgrade('codex')).status.error).toBe('agent-cli-active')
    finish(); await call
    expect(deps.terminals.upgradeCli).not.toHaveBeenCalled()
  })
})
