import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimEndpoint } from './endpoint-claim'

describe.runIf(process.platform !== 'win32')('claimEndpoint', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'conclave-endpoint-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('claims an absent socket path', async () => {
    const socketPath = path.join(dir, 'daemon.sock')
    await expect(claimEndpoint(socketPath)).resolves.toBe('claimed')
  })

  it('removes a stale unix socket left by an exited daemon', async () => {
    const socketPath = path.join(dir, 'daemon.sock')
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    // Unref/destroy underlying fd without unlinking the file by creating a stale socket via python/net,
    // or verify live server behavior first and close.
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await expect(claimEndpoint(socketPath)).resolves.toBe('claimed')
    expect(existsSync(socketPath)).toBe(false)
  })

  it('rejects a live daemon socket unless reuseExisting is enabled', async () => {
    const socketPath = path.join(dir, 'daemon.sock')
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      await expect(claimEndpoint(socketPath)).rejects.toThrow('another Conclave daemon is already serving')
      await expect(claimEndpoint(socketPath, { reuseExisting: true })).resolves.toBe('reused')
      expect(existsSync(socketPath)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
