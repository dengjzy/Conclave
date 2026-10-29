import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SquadStore } from './squad-store'
import { MIGRATIONS, TaskStore } from './task-store'
import { applyLegacyMigrations } from './legacy-database'

describe('squad persistence', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'conclave-squad-store-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  it('upgrades existing tasks without changing their agent, projects or status', () => {
    const file = path.join(root, 'db')
    const legacy = new DatabaseSync(file)
    applyLegacyMigrations(legacy, MIGRATIONS.slice(0, -1))
    legacy.prepare("INSERT INTO tasks (id, title, slug, status, agent, created_at, updated_at) VALUES ('old', 'Legacy task', 'legacy-task', 'pending', 'claude', 1, 1)").run()
    legacy.prepare("INSERT INTO task_repos (task_id, position, path) VALUES ('old', 0, '/project')").run()
    legacy.close()
    const tasks = new TaskStore(file)
    expect(tasks.get('old')).toMatchObject({ title: 'Legacy task', slug: 'legacy-task', status: 'pending', agent: 'claude', squadId: null, repos: [{ path: '/project' }] })
    const squads = new SquadStore(file)
    expect(squads.list()).toEqual([])
    squads.close(); tasks.close()
  })
  it('persists archive and restore independently of stored task runs', () => {
    const file = path.join(root, 'db')
    const tasks = new TaskStore(file)
    let squads = new SquadStore(file)
    const lead = '00000001-0000-4000-8000-000000000000'
    const dev = '00000002-0000-4000-8000-000000000000'
    const squad = squads.create({ name: 'Team', leaderId: lead, members: [
      { id: lead, name: 'Lead', agent: 'claude', capability: 'readOnly' },
      { id: dev, name: 'Dev', agent: 'codex', capability: 'develop' }
    ] })
    squads.archive(squad.id, true); squads.close()
    squads = new SquadStore(file)
    expect(squads.get(squad.id).archivedAt).not.toBeNull()
    squads.archive(squad.id, false)
    expect(squads.get(squad.id).archivedAt).toBeNull()
    squads.close(); tasks.close()
  })
})
