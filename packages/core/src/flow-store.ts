import { DatabaseSync } from 'node:sqlite'
import { Flow, type AgentKind } from '@conclave/protocol'
import { Rejection } from './rejection'

export type AgentStat = { attempts: number; passes: number; failures: number }

export class FlowStore {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  close(): void { this.db.close() }

  list(taskId?: string): Flow[] {
    const rows = taskId
      ? this.db.prepare('SELECT data FROM flows WHERE task_id = ? ORDER BY rowid DESC').all(taskId)
      : this.db.prepare('SELECT data FROM flows ORDER BY rowid DESC').all()
    return rows.map((row) => Flow.parse(JSON.parse(String(row.data))))
  }

  get(id: string): Flow {
    const row = this.db.prepare('SELECT data FROM flows WHERE id = ?').get(id)
    if (!row) throw new Rejection('flow-not-found')
    return Flow.parse(JSON.parse(String(row.data)))
  }

  save(flow: Flow): Flow {
    const parsed = Flow.parse(flow)
    this.db.prepare('INSERT INTO flows (id, task_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(parsed.id, parsed.taskId, JSON.stringify(parsed))
    return parsed
  }

  patched(id: string, patch: Partial<Flow>): Flow {
    return this.save({ ...this.get(id), ...patch })
  }

  // How each agent has done across every flow, for choosing who tries next. Small numbers are
  // expected at first; a missing agent is not the same as a bad one, so callers keep their order.
  agentStats(): Map<AgentKind, AgentStat> {
    const stats = new Map<AgentKind, AgentStat>()
    for (const flow of this.list()) {
      for (const attempt of flow.attempts) {
        if (!attempt.agent) continue
        const stat = stats.get(attempt.agent) ?? { attempts: 0, passes: 0, failures: 0 }
        stat.attempts += 1
        if (attempt.result === 'pass') stat.passes += 1
        if (attempt.result === 'fail') stat.failures += 1
        stats.set(attempt.agent, stat)
      }
    }
    return stats
  }

  // The run still holding a task, if one is: a finished or cancelled one does not block a new flow.
  active(taskId: string): Flow | null {
    return this.list(taskId).find((flow) => flow.state === 'running' || flow.state === 'paused') ?? null
  }

  remove(taskId: string): void {
    this.db.prepare('DELETE FROM flows WHERE task_id = ?').run(taskId)
  }
}
