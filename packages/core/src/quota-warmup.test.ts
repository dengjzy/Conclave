import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { daemonSchemas, type DaemonEvent, type DaemonParams } from '@conclave/protocol/node'
import type { ModelMetering } from '@conclave/protocol'
import type { SessionHost } from './daemon-client'
import { daemonQuick, warmAccount, WarmupUncertain } from './quota-warmup'

describe('daemon-owned quota warmup', () => {
  it('keeps output arriving between the attach snapshot and its response and releases the process', async () => {
    const listeners = new Set<(event: DaemonEvent) => void>(), calls: string[] = []
    const host: SessionHost = {
      onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      request: async (method) => {
        calls.push(method)
        let result: unknown = { ok: true }
        if (method === 'spawnPipe') result = { sessionId: 'warmup' }
        if (method === 'attach') {
          result = { sessionId: 'warmup', io: 'pipe', buffer: 'hello', bufferStart: 0, endOffset: 5, exited: true, exitCode: 0 }
          for (const listener of listeners) listener({ event: 'data', sessionId: 'warmup', data: ' world', offset: 5 })
        }
        return daemonSchemas[method].result.parse(result)
      }
    }
    expect(await daemonQuick(host, { command: 'fake-agent', args: ['--', 'OK'], stdin: null, output: 'stdout' }, '/test')).toBe('hello world')
    expect(calls).toEqual(['spawnPipe', 'attach', 'release'])
    expect(listeners.size).toBe(0)
  })
  it('pins the MCP probe and minimal request to the same account and disables discovered servers', async () => {
    const launches: DaemonParams<'spawnPipe'>[] = [], recorded: ModelMetering[] = []
    const host: SessionHost = {
      onEvent: () => () => {},
      request: async (method, params) => {
        let result: unknown = { ok: true }
        if (method === 'spawnPipe') {
          const launch = daemonSchemas.spawnPipe.params.parse(params)
          launches.push(launch)
          const outputIndex = launch.args.indexOf('-o')
          if (outputIndex !== -1) {
            const file = launch.args[outputIndex + 1]
            if (!file) throw new Error('missing output file')
            await writeFile(file, 'OK')
          }
          result = { sessionId: String(launches.length) }
        }
        if (method === 'attach') {
          const buffer = launches.length === 1 ? '[{"name":"configured_server"}]' : '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
          result = { sessionId: String(launches.length), io: 'pipe', buffer, bufferStart: 0, endOffset: buffer.length, exited: true, exitCode: 0 }
        }
        return daemonSchemas[method].result.parse(result)
      }
    }
    await warmAccount(host, { launch: async (_agent, account) => ({ id: account ?? 'default', env: { CODEX_HOME: '/pinned/account' } }) }, 'codex', 'work', (metering) => recorded.push(metering))
    expect(launches.map((launch) => launch.env.CODEX_HOME)).toEqual(['/pinned/account', '/pinned/account'])
    expect(launches[1]?.args).toContain('mcp_servers.configured_server.enabled=false')
    expect(launches[1]?.args.at(-2)).toBe('--')
    expect(recorded[0]?.models).toMatchObject([{ input: 10, output: 2 }])
  })
  it('stops a spawned request when attaching fails and marks its outcome uncertain', async () => {
    const calls: string[] = []
    const host: SessionHost = {
      onEvent: () => () => {},
      request: async (method) => {
        calls.push(method)
        if (method === 'attach') throw new Error('disconnected')
        return daemonSchemas[method].result.parse(method === 'spawnPipe' ? { sessionId: 'warmup' } : { ok: true })
      }
    }
    await expect(daemonQuick(host, { command: 'fake', args: [], stdin: null, output: 'stdout' }, '/test')).rejects.toBeInstanceOf(WarmupUncertain)
    expect(calls).toEqual(['spawnPipe', 'attach', 'kill', 'release'])
  })
})
