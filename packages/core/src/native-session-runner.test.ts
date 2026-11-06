import { describe, expect, it } from 'vitest'
import { daemonSchemas, type DaemonEvent, type DaemonMethod, type DaemonParams, type SessionInfo } from '@conclave/protocol/node'
import type { SessionHost } from './daemon-client'
import { NativeSessionRunner } from './native-session-runner'
import { AcpDriver } from './agents/acp/acp-driver'
import { kimiDialect } from './agents/kimi/kimi-dialect'

function daemon(options: { capability?: boolean; silent?: boolean; error?: string; stubborn?: boolean; commandOutput?: string; commandCode?: number; duplicate?: boolean; catalog?: boolean } = {}) {
  const listeners = new Set<(event: DaemonEvent) => void>()
  const calls: string[] = [], methods: string[] = []
  let output = '', exited = false, code = 0
  const emit = (event: DaemonEvent) => listeners.forEach((listener) => listener(event))
  const print = (frame: unknown) => {
    const data = `${JSON.stringify(frame)}\n`, offset = output.length
    output += data
    emit({ event: 'data', sessionId: 'cleanup', data, offset })
  }
  const info = (): SessionInfo & { buffer: string; bufferStart: number; endOffset: number; stderr: string } => ({ sessionId: 'cleanup', io: 'pipe', exited, exitCode: exited ? code : null, buffer: output, bufferStart: 0, endOffset: output.length, stderr: '' })
  const host: SessionHost = {
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async request<M extends DaemonMethod>(method: M, raw: DaemonParams<M>) {
      calls.push(method)
      let result: unknown = { ok: true }
      if (method === 'spawnPipe') {
        result = { sessionId: 'cleanup' }
        if (options.commandOutput !== undefined) { output = options.commandOutput; exited = true; code = options.commandCode ?? 0 }
      } else if (method === 'attach') {
        result = info()
        if (options.duplicate && output) emit({ event: 'data', sessionId: 'cleanup', data: output, offset: 0 })
      } else if (method === 'write') {
        const { data } = daemonSchemas.write.params.parse(raw)
        const frame = JSON.parse(data)
        methods.push(frame.method ?? '')
        if (!options.silent) queueMicrotask(() => {
          if (frame.method === 'initialize') print({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: options.capability === false ? {} : { delete: {} } } } })
          else if (options.catalog && frame.method === 'session/new') print({ id: frame.id, result: { sessionId: '00000001-0000-4000-8000-000000000000', configOptions: [{ id: 'model', category: 'model', name: 'Model', currentValue: 'fake', type: 'select', options: [{ value: 'fake', name: 'Fake' }] }] } })
          else if (options.error) print({ id: frame.id, error: { code: -32602, message: options.error } })
          else print({ id: frame.id, result: {} })
        })
      } else if (method === 'kill') {
        const { force } = daemonSchemas.kill.params.parse(raw)
        if (!options.stubborn || force) { exited = true; code = 143; emit({ event: 'exit', sessionId: 'cleanup', exitCode: code }) }
      }
      return daemonSchemas[method].result.parse(result)
    }
  }
  return { host, calls, methods, listeners }
}

const launch = { command: 'fake-agent', args: ['acp'] }

describe('daemon-managed native session cleanup', () => {
  it('deletes over ACP without opening or resuming a model session and releases the process', async () => {
    const fake = daemon()
    await new NativeSessionRunner(fake.host).acp(launch, '/project', 'session/delete', { sessionId: 'native' })
    expect(fake.methods).toEqual(['initialize', 'session/delete'])
    expect(fake.calls).toContain('kill')
    expect(fake.calls.at(-1)).toBe('release')
    expect(fake.listeners.size).toBe(0)
  })

  it('refuses a CLI that does not advertise delete, preserves RPC errors, and stops both processes', async () => {
    const unsupported = daemon({ capability: false })
    await expect(new NativeSessionRunner(unsupported.host).acp(launch, '/project', 'session/delete', {})).rejects.toMatchObject({ reason: 'native-session-delete-unsupported' })
    expect(unsupported.methods).toEqual(['initialize'])
    expect(unsupported.calls.at(-1)).toBe('release')
    const failed = daemon({ error: 'session locked' })
    await expect(new NativeSessionRunner(failed.host).acp(launch, '/project', 'session/delete', {})).rejects.toMatchObject({ code: -32602, message: 'session locked' })
    expect(failed.listeners.size).toBe(0)
  })

  it('times out and escalates a process that ignores termination', async () => {
    const fake = daemon({ silent: true, stubborn: true })
    await expect(new NativeSessionRunner(fake.host, 5, 5).acp(launch, '/project', 'session/delete', {})).rejects.toMatchObject({ reason: 'native-session-timeout' })
    expect(fake.calls.filter((method) => method === 'kill')).toHaveLength(2)
    expect(fake.listeners.size).toBe(0)
  })

  it('uses the daemon for model probes and refuses to create one without a durable cleanup handler', async () => {
    const unsupported = daemon({ catalog: true })
    const driver = new AcpDriver(kimiDialect, 'catalog', { cwd: '/project', extraDirs: [], resume: null })
    expect(await new NativeSessionRunner(unsupported.host).catalog(driver, launch, '/project')).toBeNull()
    expect(unsupported.calls).toEqual([])
    const fake = daemon({ catalog: true })
    const runner = new NativeSessionRunner(fake.host, undefined, undefined, async () => {}, async () => {})
    let registered = false
    const catalog = await runner.catalog(driver, launch, '/project', async (id, daemonId) => {
      expect(id).toBe('00000001-0000-4000-8000-000000000000')
      expect(daemonId).toBe('cleanup')
      registered = true
    })
    expect(registered).toBe(true)
    expect(catalog?.models[0]?.id).toBe('fake')
    expect(fake.methods).toContain('session/new')
    expect(fake.methods).not.toContain('session/prompt')
    expect(fake.calls.at(-1)).toBe('release')
  })

  it('handles a command that exited before attach, without duplicating buffered output', async () => {
    const fake = daemon({ commandOutput: 'deleted\n', duplicate: true })
    expect(await new NativeSessionRunner(fake.host).command(launch, '/project')).toBe('deleted\n')
    expect(fake.calls).toEqual(['spawnPipe', 'attach', 'release'])
    const failed = daemon({ commandOutput: '', commandCode: 1 })
    await expect(new NativeSessionRunner(failed.host).command(launch, '/project')).rejects.toMatchObject({ reason: 'native-session-command-failed' })
  })
})
