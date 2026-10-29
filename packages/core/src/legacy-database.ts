import type { DatabaseSync } from 'node:sqlite'

// A test's database as an older Conclave left it: these migrations applied and user_version set to
// their count. One transaction, as TaskStore runs each of them in one: statement by statement, each
// its own commit to disk, a full test run's busy disk can stretch building it past a test's timeout.
export function applyLegacyMigrations(db: DatabaseSync, migrations: readonly string[]): void {
  db.exec('BEGIN')
  for (const sql of migrations) db.exec(sql)
  db.exec(`PRAGMA user_version = ${migrations.length}`)
  db.exec('COMMIT')
}
