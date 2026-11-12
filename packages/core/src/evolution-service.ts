import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type AgentKind,
  type EvolutionGeneration,
  type EvolutionStatus,
  type FrictionItem,
  type Task
} from '@conclave/protocol'
import type { FlowService } from './flow-service'
import type { TaskService } from './task-service'
import { Rejection } from './rejection'

type Tasks = Pick<TaskService, 'create' | 'get' | 'update' | 'setContract' | 'contract'>
type Flows = Pick<FlowService, 'start' | 'get'>

export class EvolutionService {
  private readonly selfDir: string
  private activeGeneration: EvolutionGeneration | null = null

  constructor(
    private readonly home: string,
    private readonly repoRoot: string,
    private readonly tasks: Tasks,
    private readonly flows: Flows,
    private readonly events: { changed: (status: EvolutionStatus) => void }
  ) {
    this.selfDir = path.join(this.home, 'self')
  }

  private git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.repoRoot, encoding: 'utf8' }).trim()
  }

  private isAncestor(ancestor: string, descendant: string): boolean {
    return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: this.repoRoot }).status === 0
  }

  async listFriction(): Promise<FrictionItem[]> {
    const file = path.join(this.selfDir, 'friction.json')
    try {
      return JSON.parse(await readFile(file, 'utf8')) as FrictionItem[]
    } catch {
      return []
    }
  }

  async addFriction(item: { summary: string; repro: string; expect: string; paths?: string[] }): Promise<FrictionItem> {
    const items = await this.listFriction()
    const slug = item.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    const id = slug || `f-${createHash('sha1').update(item.summary).digest('hex').slice(0, 8)}`
    if (items.some((each) => each.id === id)) {
      throw new Rejection('friction-already-exists', `改进项 ${id} 已存在`)
    }
    const now = new Date().toISOString()
    const friction: FrictionItem = {
      id,
      summary: item.summary.trim(),
      repro: item.repro.trim(),
      expect: item.expect.trim(),
      paths: item.paths ?? [],
      status: 'open',
      createdAt: now,
      updatedAt: now
    }
    items.push(friction)
    await mkdir(this.selfDir, { recursive: true })
    await writeFile(path.join(this.selfDir, 'friction.json'), `${JSON.stringify(items, null, 2)}\n`)
    this.announce()
    return friction
  }

  async listGenerations(limit = 10): Promise<EvolutionGeneration[]> {
    const dir = path.join(this.selfDir, 'generations')
    try {
      const { readdir } = await import('node:fs/promises')
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit)
      const reports = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8')) as EvolutionGeneration))
      return reports
    } catch {
      return []
    }
  }

  async status(): Promise<EvolutionStatus> {
    const items = await this.listFriction()
    let baseCommit = ''
    try {
      baseCommit = this.git('rev-parse', 'self/evolve')
    } catch {
      baseCommit = 'unknown'
    }
    const recent = await this.listGenerations(5)
    return {
      stagingBranch: 'self/evolve',
      baseCommit,
      activeGeneration: this.activeGeneration,
      openFrictionCount: items.filter((item) => item.status === 'open').length,
      recentGenerations: recent
    }
  }

  async trigger(options: { frictionId?: string; agent?: AgentKind; dryRun?: boolean } = {}): Promise<EvolutionGeneration> {
    if (this.activeGeneration?.state === 'running') {
      throw new Rejection('generation-active', '当前已有正在运行的自我迭代任务')
    }
    const items = await this.listFriction()
    const friction = options.frictionId
      ? items.find((i) => i.id === options.frictionId)
      : items.find((i) => i.status === 'open')
    if (!friction) {
      throw new Rejection('no-open-friction', '没有待处理的改进项')
    }

    if (this.git('status', '--porcelain')) {
      throw new Rejection('worktree-dirty', '工作区有未提交的改动，请先提交或 stash')
    }

    const base = this.git('rev-parse', 'self/evolve')
    const checks = [
      { repo: this.repoRoot, command: 'pnpm typecheck', timeoutMs: 600_000, required: true },
      { repo: this.repoRoot, command: 'pnpm test', timeoutMs: 900_000, required: true },
      { repo: this.repoRoot, command: 'pnpm build', timeoutMs: 600_000, required: true },
      { repo: this.repoRoot, command: 'pnpm self:smoke', timeoutMs: 180_000, required: true },
      { repo: this.repoRoot, command: `node scripts/self-test-policy.mjs --base ${base}`, timeoutMs: 120_000, required: true }
    ]

    const details = [
      `问题：${friction.summary}`,
      `复现：${friction.repro}`,
      `预期：${friction.expect}`,
      friction.paths?.length ? `允许改动的路径：${friction.paths.join('、')}` : '',
      '要求：',
      '- 先复现，再改；改完自己跑 pnpm typecheck 和 pnpm test。',
      '- 测试可以改，但不许删测试、减用例或加 skip：self:tests 会因此判负。',
      '- 保持改动最小且可安全合入。'
    ].filter(Boolean).join('\n')

    const agent = options.agent ?? 'dsh'
    const task = this.tasks.create({
      title: `self: ${friction.summary}`.slice(0, 200),
      details,
      repos: [this.repoRoot],
      agent,
      dependsOn: []
    })

    this.tasks.update({ id: task.id, starts: [{ path: this.repoRoot, ref: 'refs/heads/self/evolve' }] })
    this.tasks.setContract(task.id, {
      goal: friction.expect,
      verification: { checks, baseline: [], criteria: [], human: [], unknowns: [] },
      constraints: { maxAttempts: 2, maxWallClockMs: 45 * 60_000 },
      risk: 'medium',
      autonomy: 'confirm'
    })

    const flow = await this.flows.start(task.id)
    const generation: EvolutionGeneration = {
      id: randomUUID(),
      frictionId: friction.id,
      taskId: task.id,
      flowId: flow.id,
      agent,
      base,
      branch: `task-${task.id}`,
      tip: null,
      checks,
      state: 'running',
      note: null,
      report: null,
      merged: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    this.activeGeneration = generation
    this.announce()
    return generation
  }

  async completeGeneration(taskId: string): Promise<EvolutionGeneration | null> {
    if (!this.activeGeneration || this.activeGeneration.taskId !== taskId) return null
    const task = this.tasks.get(taskId)
    const repo = task.repos.find((e) => !e.reference) ?? task.repos[0]
    if (!repo?.branch || !repo.worktreePath) return null

    if (this.git('-C', repo.worktreePath, 'status', '--porcelain')) {
      this.git('-C', repo.worktreePath, 'add', '-A')
      this.git('-C', repo.worktreePath, 'commit', '-m', `self(${this.activeGeneration.frictionId}): ${task.title}`)
    }

    const tip = this.git('-C', repo.worktreePath, 'rev-parse', 'HEAD')
    if (this.isAncestor(this.activeGeneration.base, tip) && this.isAncestor('self/evolve', tip)) {
      this.git('branch', '-f', 'self/evolve', tip)
      this.activeGeneration.merged = true
      this.activeGeneration.state = 'merged'
      this.activeGeneration.tip = tip
    } else {
      this.activeGeneration.state = 'passed'
      this.activeGeneration.tip = tip
    }

    const dir = path.join(this.selfDir, 'generations')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${this.activeGeneration.frictionId ?? 'gen'}-${Date.now()}.json`)
    await writeFile(file, `${JSON.stringify(this.activeGeneration, null, 2)}\n`)

    const finished = this.activeGeneration
    this.activeGeneration = null
    this.announce()
    return finished
  }

  private announce(): void {
    void this.status().then((status) => this.events.changed(status)).catch(() => {})
  }
}
