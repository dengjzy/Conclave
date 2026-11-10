import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskStore } from './task-store'
import { IdeaStore } from './idea-store'

describe('IdeaStore', () => {
  let dir: string
  let ideas: IdeaStore
  let changed: number

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conclave-ideas-'))
    const db = path.join(dir, 'conclave.db')
    new TaskStore(db).close()
    changed = 0
    ideas = new IdeaStore(db, () => { changed++ })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates an idea without a project or a conversation', () => {
    const idea = ideas.create({ title: 'A portable note', notes: 'Try it', status: 'idea', tags: ['writing'], projectPath: null })
    expect(idea).toMatchObject({ title: 'A portable note', status: 'idea', tags: ['writing'], conversationId: null, taskId: null })
    expect(ideas.list()).toEqual([idea])
    expect(changed).toBe(1)
  })

  it('moves an idea to todo and edits its text', () => {
    const idea = ideas.create({ title: 'A todo', notes: '', status: 'todo', tags: [], projectPath: null })
    const next = ideas.update(idea.id, { title: 'A finished todo', status: 'done' })
    expect(next).toMatchObject({ id: idea.id, title: 'A finished todo', status: 'done' })
    expect(ideas.list()[0]?.status).toBe('done')
  })

  it('removes an idea', () => {
    const idea = ideas.create({ title: 'Gone', notes: '', status: 'idea', tags: [], projectPath: null })
    ideas.remove(idea.id)
    expect(ideas.list()).toEqual([])
  })
})
