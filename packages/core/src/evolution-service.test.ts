import { describe, expect, it, vi } from 'vitest'
import { EvolutionService } from './evolution-service'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'

describe('EvolutionService', () => {
  it('manages friction items and queries status', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'conclave-evo-test-'))
    const mockTasks = {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      setContract: vi.fn(),
      contract: vi.fn()
    }
    const mockFlows = {
      start: vi.fn(),
      get: vi.fn()
    }
    const mockEvents = { changed: vi.fn() }

    try {
      const service = new EvolutionService(tempHome, process.cwd(), mockTasks as never, mockFlows as never, mockEvents)

      const friction = await service.addFriction({
        summary: 'Watcher leaks sockets',
        repro: 'touch file 50 times',
        expect: 'core stays responsive'
      })
      expect(friction.id).toBe('watcher-leaks-sockets')
      expect(friction.status).toBe('open')

      const items = await service.listFriction()
      expect(items).toHaveLength(1)
      expect(items[0]?.id).toBe('watcher-leaks-sockets')

      const status = await service.status()
      expect(status.openFrictionCount).toBe(1)
      expect(status.stagingBranch).toBe('self/evolve')
    } finally {
      await rm(tempHome, { recursive: true, force: true }).catch(() => {})
    }
  })
})
