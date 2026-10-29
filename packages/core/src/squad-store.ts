import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Squad, SquadFields, SquadRun, type SquadWork } from '@conclave/protocol'
import { Rejection } from './rejection'

export class SquadStore {
  private readonly db: DatabaseSync
  constructor(file: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }
  close(): void { this.db.close() }
  list(): Squad[] {
    return this.db.prepare('SELECT data FROM squads ORDER BY rowid DESC').all().map((row) => Squad.parse(JSON.parse(String(row.data))))
  }
  get(id: string): Squad {
    const row = this.db.prepare('SELECT data FROM squads WHERE id = ?').get(id)
    if (!row) throw new Rejection('squad-not-found')
    return Squad.parse(JSON.parse(String(row.data)))
  }
  create(fields: SquadFields): Squad {
    const at = this.now()
    return this.save({ ...SquadFields.parse(fields), id: randomUUID(), archivedAt: null, createdAt: at, updatedAt: at })
  }
  update(id: string, fields: SquadFields): Squad {
    return this.save({ ...this.get(id), ...SquadFields.parse(fields), updatedAt: this.now() })
  }
  archive(id: string, archived: boolean): Squad {
    return this.save({ ...this.get(id), archivedAt: archived ? this.now() : null, updatedAt: this.now() })
  }
  private save(squad: Squad): Squad {
    this.db.prepare('INSERT INTO squads (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(squad.id, JSON.stringify(squad))
    return squad
  }
  runs(taskId?: string): SquadRun[] {
    const rows = taskId ? this.db.prepare('SELECT data FROM squad_runs WHERE task_id = ? ORDER BY rowid DESC').all(taskId)
      : this.db.prepare('SELECT data FROM squad_runs ORDER BY rowid DESC').all()
    return rows.map((row) => SquadRun.parse(JSON.parse(String(row.data))))
  }
  run(id: string): SquadRun {
    const row = this.db.prepare('SELECT data FROM squad_runs WHERE id = ?').get(id)
    if (!row) throw new Rejection('squad-run-not-found')
    return SquadRun.parse(JSON.parse(String(row.data)))
  }
  saveRun(run: SquadRun): SquadRun {
    const parsed = SquadRun.parse({ ...run, updatedAt: this.now() })
    this.db.prepare('INSERT INTO squad_runs (id, task_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(parsed.id, parsed.taskId, JSON.stringify(parsed))
    return parsed
  }
  patchRun(id: string, patch: Partial<Pick<SquadRun, 'state' | 'leaderConversationId' | 'summary' | 'works' | 'delivery'>>): SquadRun {
    return this.saveRun({ ...this.run(id), ...patch })
  }
  patchWork(id: string, workId: string, patch: Partial<SquadWork>): SquadRun {
    const run = this.run(id)
    return this.patchRun(id, { works: run.works.map((work) => work.id === workId ? { ...work, ...patch, updatedAt: this.now() } : work) })
  }
  removeRuns(taskId: string): void { this.db.prepare('DELETE FROM squad_runs WHERE task_id = ?').run(taskId) }
}
