import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskContractStore } from './task-contract-store'
import { TaskStore } from './task-store'

describe('TaskContractStore', () => {
  let dir: string
  let tasks: TaskStore
  let contracts: TaskContractStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-contract-'))
    tasks = new TaskStore(path.join(dir, 'conclave.db'))
    contracts = new TaskContractStore(path.join(dir, 'conclave.db'))
  })
  afterEach(() => {
    contracts.close()
    tasks.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps one contract per task and replaces it as a whole', () => {
    const task = tasks.create('Add a filter')
    const first = contracts.save(task.id, { goal: 'filter the list' })
    expect(contracts.get(task.id)).toEqual(first)
    expect(first.goal).toBe('filter the list')

    const second = contracts.save(task.id, { goal: 'filter by project', risk: 'high' })
    expect(second.risk).toBe('high')
    expect(contracts.get(task.id)?.goal).toBe('filter by project')
  })

  it('forgets a contract with its task', () => {
    const task = tasks.create('Add a filter')
    contracts.save(task.id, { goal: 'filter' })
    contracts.delete(task.id)
    expect(contracts.get(task.id)).toBeNull()
  })

  it('refuses a task that has no contract', () => {
    const task = tasks.create('No contract')
    expect(() => contracts.require(task.id)).toThrowError(/task-contract-not-found/)
  })
})
