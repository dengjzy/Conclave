import { DatabaseSync } from 'node:sqlite'
import { TaskContract, TaskContractFields } from '@conclave/protocol'
import { Rejection } from './rejection'

// A task's contract is kept apart from the task row: it is versioned, replaced as a whole, and does
// not belong in the list the board reads on every change.
export class TaskContractStore {
  private readonly db: DatabaseSync

  constructor(file: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  close(): void { this.db.close() }

  get(taskId: string): TaskContract | null {
    const row = this.db.prepare('SELECT data FROM task_contracts WHERE task_id = ?').get(taskId)
    return row ? TaskContract.parse(JSON.parse(String(row.data))) : null
  }

  save(taskId: string, fields: TaskContractFields): TaskContract {
    const parsed = TaskContractFields.parse(fields)
    const contract = TaskContract.parse({ ...parsed, updatedAt: this.now() })
    this.db.prepare(`INSERT INTO task_contracts (task_id, version, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET version = excluded.version, data = excluded.data, updated_at = excluded.updated_at`)
      .run(taskId, contract.verification.version, JSON.stringify(contract), contract.updatedAt)
    return contract
  }

  delete(taskId: string): void {
    this.db.prepare('DELETE FROM task_contracts WHERE task_id = ?').run(taskId)
  }

  require(taskId: string): TaskContract {
    const contract = this.get(taskId)
    if (!contract) throw new Rejection('task-contract-not-found')
    return contract
  }
}
