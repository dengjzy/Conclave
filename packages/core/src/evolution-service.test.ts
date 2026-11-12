import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Flow, Task, TaskContractFields } from '@conclave/protocol'
import { EvolutionService } from './evolution-service'
import { defaultPlan } from './flow-planner'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeFlow(task: Task, state: Flow['state'], note: string | null = null): Flow {
  const now = Date.now()
  return Flow.parse({
    id: randomUUID(),
    taskId: task.id,
    state,
    nodes: defaultPlan(task, null).nodes,
    attempts: [],
    candidates: ['claude'],
    maxAttempts: 2,
    maxWallClockMs: 60_000,
    note,
    report: state === 'review' ? '门禁通过' : '门禁失败',
    createdAt: now,
    updatedAt: now
  })
}

describe('EvolutionService', () => {
  it('manages friction items and queries status', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'conclave-evo-test-'))
    const mockTasks: ConstructorParameters<typeof EvolutionService>[2] = {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      setContract: vi.fn(),
      contract: vi.fn()
    }
    const mockFlows: ConstructorParameters<typeof EvolutionService>[3] = {
      start: vi.fn(),
      get: vi.fn()
    }
    const mockEvents = { changed: vi.fn() }

    try {
      const service = new EvolutionService(tempHome, process.cwd(), mockTasks, mockFlows, mockEvents)

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
      expect(status.items).toHaveLength(1)
      expect(status.stagingBranch).toBe('self/evolve')
    } finally {
      await rm(tempHome, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('completes a generation on flow review, fast-forwards self/evolve, and marks friction done', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'conclave-evo-home-'))
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'conclave-evo-repo-'))
    const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), 'conclave-evo-wt-'))

    try {
      git(repoRoot, 'init', '-b', 'main')
      git(repoRoot, 'config', 'user.email', 'test@conclave.local')
      git(repoRoot, 'config', 'user.name', 'Conclave Test')
      await writeFile(path.join(repoRoot, 'README.md'), 'initial\n')
      git(repoRoot, 'add', '-A')
      git(repoRoot, 'commit', '-m', 'chore: initial')
      const baseSha = git(repoRoot, 'rev-parse', 'HEAD')

      const worktreeDir = path.join(worktreeRoot, 'wt-1')
      let storedTask: Task | null = null
      let runningFlow: Flow | null = null
      const movedStatuses: string[] = []

      const tasks: ConstructorParameters<typeof EvolutionService>[2] = {
        create: (fields) => {
          const now = Date.now()
          storedTask = Task.parse({
            id: 'task-evo-1',
            title: fields.title,
            details: fields.details ?? '',
            status: 'pending',
            repos: [{ path: repoRoot, worktreePath: null, branch: null }],
            dependsOn: [],
            agent: fields.agent ?? 'claude',
            createdAt: now,
            updatedAt: now
          })
          return storedTask
        },
        get: () => {
          if (!storedTask) throw new Error('missing task')
          return storedTask
        },
        update: () => {
          if (!storedTask) throw new Error('missing task')
          return storedTask
        },
        setContract: (_id, fields) => ({ ...TaskContractFields.parse(fields), updatedAt: Date.now() }),
        contract: () => null,
        move: (_id, status) => {
          movedStatuses.push(status)
          if (!storedTask) throw new Error('missing task')
          storedTask = { ...storedTask, status }
          return storedTask
        }
      }

      const flows: ConstructorParameters<typeof EvolutionService>[3] = {
        start: async (taskId) => {
          git(repoRoot, 'worktree', 'add', '-b', 'task-evo-1', worktreeDir, 'refs/heads/self/evolve')
          if (storedTask) {
            storedTask = {
              ...storedTask,
              status: 'running',
              repos: [{ path: repoRoot, worktreePath: worktreeDir, branch: 'task-evo-1', startRef: 'refs/heads/self/evolve', start: null }]
            }
          }
          if (!storedTask) throw new Error('missing task')
          runningFlow = makeFlow(storedTask, 'running')
          return runningFlow
        },
        get: () => {
          if (!runningFlow) throw new Error('missing flow')
          return runningFlow
        }
      }

      const service = new EvolutionService(tempHome, repoRoot, tasks, flows, { changed: () => {} })
      const item = await service.addFriction({
        summary: 'Improve startup message',
        repro: 'run conclave start',
        expect: 'prints clear endpoint line',
        paths: ['README.md']
      })

      const gen = await service.trigger({ frictionId: item.id, agent: 'claude' })
      expect(gen.base).toBe(baseSha)
      expect((await service.status()).openFrictionCount).toBe(0)
      expect((await service.listFriction())[0]?.status).toBe('doing')

      // Simulate agent editing the worktree and the 5-gate Flow reaching review
      await writeFile(path.join(worktreeDir, 'README.md'), 'initial\nimproved\n')
      const reviewFlow: Flow = { ...runningFlow!, state: 'review', report: '5 gates green' }
      service.observeFlow(reviewFlow)

      await expect.poll(async () => (await service.status()).activeGeneration, { timeout: 3000 }).toBeNull()
      const finalStatus = await service.status()
      expect(finalStatus.items[0]?.status).toBe('done')
      expect(finalStatus.recentGenerations).toHaveLength(1)
      expect(finalStatus.recentGenerations[0]?.state).toBe('merged')
      expect(finalStatus.recentGenerations[0]?.merged).toBe(true)
      expect(git(repoRoot, 'rev-parse', 'refs/heads/self/evolve')).toBe(finalStatus.recentGenerations[0]?.tip)
      expect(git(repoRoot, 'rev-parse', 'refs/heads/self/evolve')).not.toBe(baseSha)
      expect(movedStatuses).toEqual(['done'])
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true }).catch(() => {})
      await rm(repoRoot, { recursive: true, force: true }).catch(() => {})
      await rm(tempHome, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('reopens the friction item when a triggered generation pauses or fails', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'conclave-evo-fail-home-'))
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'conclave-evo-fail-repo-'))

    try {
      git(repoRoot, 'init', '-b', 'main')
      git(repoRoot, 'config', 'user.email', 'test@conclave.local')
      git(repoRoot, 'config', 'user.name', 'Conclave Test')
      await writeFile(path.join(repoRoot, 'README.md'), 'initial\n')
      git(repoRoot, 'add', '-A')
      git(repoRoot, 'commit', '-m', 'chore: initial')

      let storedTask: Task | null = null
      let runningFlow: Flow | null = null

      const tasks: ConstructorParameters<typeof EvolutionService>[2] = {
        create: (fields) => {
          const now = Date.now()
          storedTask = Task.parse({
            id: 'task-evo-fail',
            title: fields.title,
            details: fields.details ?? '',
            status: 'pending',
            repos: [{ path: repoRoot, worktreePath: null, branch: null }],
            dependsOn: [],
            agent: fields.agent ?? 'claude',
            createdAt: now,
            updatedAt: now
          })
          return storedTask
        },
        get: () => {
          if (!storedTask) throw new Error('missing task')
          return storedTask
        },
        update: () => {
          if (!storedTask) throw new Error('missing task')
          return storedTask
        },
        setContract: (_id, fields) => ({ ...TaskContractFields.parse(fields), updatedAt: Date.now() }),
        contract: () => null
      }

      const flows: ConstructorParameters<typeof EvolutionService>[3] = {
        start: async (taskId) => {
          if (!storedTask) throw new Error('missing task')
          runningFlow = makeFlow(storedTask, 'running')
          return runningFlow
        },
        get: () => {
          if (!runningFlow) throw new Error('missing flow')
          return runningFlow
        }
      }

      const service = new EvolutionService(tempHome, repoRoot, tasks, flows, { changed: () => {} })
      const item = await service.addFriction({
        summary: 'Fix flaky gate',
        repro: 'pnpm self:smoke',
        expect: 'exits 0'
      })
      await service.trigger({ frictionId: item.id, agent: 'claude' })
      expect((await service.listFriction())[0]?.status).toBe('doing')

      service.observeFlow({ ...runningFlow!, state: 'paused', note: 'self:tests gate failed' })
      await expect.poll(async () => (await service.status()).activeGeneration, { timeout: 3000 }).toBeNull()

      const finalStatus = await service.status()
      expect(finalStatus.openFrictionCount).toBe(1)
      expect(finalStatus.items[0]?.status).toBe('open')
      expect(finalStatus.recentGenerations[0]?.state).toBe('failed')
    } finally {
      await rm(repoRoot, { recursive: true, force: true }).catch(() => {})
      await rm(tempHome, { recursive: true, force: true }).catch(() => {})
    }
  })
})
