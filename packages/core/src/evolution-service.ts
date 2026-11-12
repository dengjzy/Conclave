import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  EvolutionGeneration,
  FrictionItem,
  type AgentKind,
  type EvolutionStatus,
  type Flow,
  type FrictionStatus
} from '@conclave/protocol'
import type { FlowService } from './flow-service'
import type { TaskService } from './task-service'
import { Rejection } from './rejection'

type Tasks = Pick<TaskService, 'create' | 'get' | 'update' | 'setContract' | 'contract'> & {
  move?: TaskService['move']
}
type Flows = Pick<FlowService, 'start' | 'get'>

export class EvolutionService {
  private readonly selfDir: string
  private activeGeneration: EvolutionGeneration | null = null
  private chain: Promise<unknown> = Promise.resolve()

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

  private hasRef(ref: string): boolean {
    return spawnSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd: this.repoRoot }).status === 0
  }

  private isAncestor(ancestor: string, descendant: string): boolean {
    return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: this.repoRoot }).status === 0
  }

  private resolveStagingBase(ensureBranch = false): string {
    if (this.hasRef('refs/heads/self/evolve')) {
      return this.git('rev-parse', 'refs/heads/self/evolve')
    }
    try {
      const head = this.git('rev-parse', 'HEAD')
      if (ensureBranch) {
        this.git('branch', 'self/evolve', head)
      }
      return head
    } catch {
      return 'unknown'
    }
  }

  private async currentActive(): Promise<EvolutionGeneration | null> {
    if (this.activeGeneration) return this.activeGeneration
    try {
      const raw = await readFile(path.join(this.selfDir, 'active.json'), 'utf8')
      this.activeGeneration = EvolutionGeneration.parse(JSON.parse(raw))
      return this.activeGeneration
    } catch {
      return null
    }
  }

  private async saveActive(generation: EvolutionGeneration | null): Promise<void> {
    this.activeGeneration = generation
    const file = path.join(this.selfDir, 'active.json')
    if (!generation) {
      await rm(file, { force: true }).catch(() => {})
      return
    }
    await mkdir(this.selfDir, { recursive: true })
    await writeFile(file, `${JSON.stringify(generation, null, 2)}\n`)
  }

  async listFriction(): Promise<FrictionItem[]> {
    const file = path.join(this.selfDir, 'friction.json')
    try {
      return z.array(FrictionItem).parse(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      return []
    }
  }

  private async writeFriction(items: readonly FrictionItem[]): Promise<void> {
    await mkdir(this.selfDir, { recursive: true })
    await writeFile(path.join(this.selfDir, 'friction.json'), `${JSON.stringify(items, null, 2)}\n`)
  }

  private async updateFrictionStatus(id: string | null, status: FrictionStatus): Promise<void> {
    if (!id) return
    const items = await this.listFriction()
    const now = new Date().toISOString()
    const next = items.map((item) => (item.id === id ? { ...item, status, updatedAt: now } : item))
    await this.writeFriction(next)
  }

  async addFriction(item: { summary: string; repro: string; expect: string; paths?: string[] }): Promise<FrictionItem> {
    const items = await this.listFriction()
    const slug = item.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    const id = slug || `f-${createHash('sha1').update(item.summary).digest('hex').slice(0, 8)}`
    if (items.some((each) => each.id === id && each.status !== 'done' && each.status !== 'dropped')) {
      throw new Rejection('friction-already-exists', `改进项 ${id} 已存在`)
    }
    const uniqueId = items.some((each) => each.id === id) ? `${id}-${Date.now().toString(36)}` : id
    const now = new Date().toISOString()
    const friction: FrictionItem = {
      id: uniqueId,
      summary: item.summary.trim(),
      repro: item.repro.trim(),
      expect: item.expect.trim(),
      paths: item.paths ?? [],
      status: 'open',
      createdAt: now,
      updatedAt: now
    }
    items.push(friction)
    await this.writeFriction(items)
    this.announce()
    return friction
  }

  async listGenerations(limit = 10): Promise<EvolutionGeneration[]> {
    const dir = path.join(this.selfDir, 'generations')
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit)
      const reports = await Promise.all(
        files.map(async (f) => EvolutionGeneration.parse(JSON.parse(await readFile(path.join(dir, f), 'utf8'))))
      )
      return reports
    } catch {
      return []
    }
  }

  async status(): Promise<EvolutionStatus> {
    const [items, active, recent] = await Promise.all([
      this.listFriction(),
      this.currentActive(),
      this.listGenerations(10)
    ])
    const baseCommit = this.resolveStagingBase(false)
    return {
      stagingBranch: 'self/evolve',
      baseCommit,
      activeGeneration: active,
      openFrictionCount: items.filter((item) => item.status === 'open').length,
      items,
      recentGenerations: recent
    }
  }

  async trigger(options: { frictionId?: string; agent?: AgentKind; dryRun?: boolean } = {}): Promise<EvolutionGeneration> {
    const active = await this.currentActive()
    if (active?.state === 'running') {
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

    const base = this.resolveStagingBase(!options.dryRun)
    const checks = [
      { repo: this.repoRoot, command: 'pnpm typecheck', timeoutMs: 600_000, required: true },
      { repo: this.repoRoot, command: 'pnpm test', timeoutMs: 900_000, required: true },
      { repo: this.repoRoot, command: 'pnpm build', timeoutMs: 600_000, required: true },
      { repo: this.repoRoot, command: 'pnpm self:smoke', timeoutMs: 180_000, required: true },
      { repo: this.repoRoot, command: `node scripts/self-test-policy.mjs --base ${base}`, timeoutMs: 120_000, required: true }
    ]

    if (options.dryRun) {
      const now = new Date().toISOString()
      return {
        id: randomUUID(),
        frictionId: friction.id,
        taskId: 'dry-run',
        flowId: randomUUID(),
        agent: options.agent ?? 'claude',
        base,
        branch: `self/dry-run-${friction.id}`,
        tip: null,
        checks,
        state: 'running',
        note: 'dry-run',
        report: null,
        merged: false,
        createdAt: now,
        updatedAt: now
      }
    }

    const details = [
      `问题：${friction.summary}`,
      `复现：${friction.repro}`,
      `预期：${friction.expect}`,
      friction.paths?.length ? `允许改动的路径：${friction.paths.join('、')}` : '',
      '要求：',
      '- 先复现，再修改；完成后运行 pnpm typecheck 和 pnpm test。',
      '- 测试可以按需调整，但不得删除测试文件、减少测试用例或新增 skip（self:tests 门禁会校验）。',
      '- 保持改动最小且可安全快进合入。'
    ].filter(Boolean).join('\n')

    const task = this.tasks.create({
      title: `self: ${friction.summary}`.slice(0, 200),
      details,
      repos: [this.repoRoot],
      agent: options.agent ?? null,
      dependsOn: []
    })

    this.tasks.update({ id: task.id, starts: [{ path: this.repoRoot, ref: 'refs/heads/self/evolve' }] })
    this.tasks.setContract(task.id, {
      goal: friction.expect,
      verification: { checks, baseline: [], criteria: [], human: [], unknowns: [] },
      constraints: { maxAttempts: 2, maxWallClockMs: 45 * 60_000 },
      risk: 'medium',
      autonomy: 'auto'
    })

    await this.updateFrictionStatus(friction.id, 'doing')
    let flow: Flow
    try {
      flow = await this.flows.start(task.id)
    } catch (error) {
      await this.updateFrictionStatus(friction.id, 'open')
      throw error
    }
    const resolvedAgent = this.tasks.get(task.id)?.agent ?? options.agent ?? 'claude'
    const now = new Date().toISOString()
    const generation: EvolutionGeneration = {
      id: randomUUID(),
      frictionId: friction.id,
      taskId: task.id,
      flowId: flow.id,
      agent: resolvedAgent,
      base,
      branch: `task-${task.id}`,
      tip: null,
      checks,
      state: 'running',
      note: null,
      report: null,
      merged: false,
      createdAt: now,
      updatedAt: now
    }
    await this.saveActive(generation)
    this.announce()
    // If the flow already reached a terminal/review state synchronously during start, reconcile it now.
    if (flow.state !== 'running') {
      this.observeFlow(flow)
    }
    return generation
  }

  observeFlow(flow: Flow): void {
    this.chain = this.chain
      .catch(() => {})
      .then(async () => {
        const active = await this.currentActive()
        if (!active || active.flowId !== flow.id) return
        if (flow.state === 'review') {
          await this.completeGeneration(flow.taskId, flow)
        } else if (flow.state === 'paused' || flow.state === 'failed' || flow.state === 'cancelled') {
          await this.failGeneration(flow)
        }
      })
  }

  async completeGeneration(taskId: string, flow?: Flow): Promise<EvolutionGeneration | null> {
    const active = await this.currentActive()
    if (!active || active.taskId !== taskId) return null
    const task = this.tasks.get(taskId)
    const repo = task.repos.find((e) => !e.reference) ?? task.repos[0]
    if (!repo?.branch || !repo.worktreePath) return null

    if (this.git('-C', repo.worktreePath, 'status', '--porcelain')) {
      this.git('-C', repo.worktreePath, 'add', '-A')
      this.git('-C', repo.worktreePath, 'commit', '-m', `self(${active.frictionId ?? 'gen'}): ${task.title}`)
    }

    const tip = this.git('-C', repo.worktreePath, 'rev-parse', 'HEAD')
    const now = new Date().toISOString()
    const finished: EvolutionGeneration = {
      ...active,
      branch: repo.branch,
      tip,
      note: flow?.note ?? active.note,
      report: flow?.report ?? active.report,
      updatedAt: now
    }

    if (this.isAncestor(active.base, tip) && this.isAncestor('refs/heads/self/evolve', tip)) {
      this.git('branch', '-f', 'self/evolve', tip)
      finished.merged = true
      finished.state = 'merged'
      try {
        this.tasks.move?.(taskId, 'done')
      } catch {}
    } else {
      finished.state = 'passed'
    }

    await this.updateFrictionStatus(active.frictionId, 'done')
    await this.writeGenerationRecord(finished)
    await this.saveActive(null)
    this.announce()
    return finished
  }

  private async failGeneration(flow: Flow): Promise<EvolutionGeneration | null> {
    const active = await this.currentActive()
    if (!active || active.flowId !== flow.id) return null
    const finished: EvolutionGeneration = {
      ...active,
      state: 'failed',
      note: flow.note,
      report: flow.report,
      updatedAt: new Date().toISOString()
    }
    await this.updateFrictionStatus(active.frictionId, 'open')
    await this.writeGenerationRecord(finished)
    await this.saveActive(null)
    this.announce()
    return finished
  }

  private async writeGenerationRecord(generation: EvolutionGeneration): Promise<void> {
    const dir = path.join(this.selfDir, 'generations')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}-${generation.frictionId ?? generation.id.slice(0, 8)}.json`)
    await writeFile(file, `${JSON.stringify(generation, null, 2)}\n`)
  }

  private announce(): void {
    void this.status().then((status) => this.events.changed(status)).catch(() => {})
  }
}
