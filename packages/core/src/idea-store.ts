import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Idea, type IdeaFields } from '@conclave/protocol'
import { Rejection } from './rejection'

type Row = { id: string; title: string; notes: string; status: string; tags: string; projectPath: string | null; conversationId: string | null; taskId: string | null; createdAt: number; updatedAt: number }

// Ideas and standalone to-dos, kept apart from conversations. They have no agent and no run until
// the user starts one; that is the point of the page.
export class IdeaStore {
  private readonly db: DatabaseSync

  constructor(file: string, private readonly changed: (idea: Idea | null) => void = () => {}, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  list(): Idea[] {
    return this.db.prepare(`SELECT id, title, notes, status, tags, project_path AS projectPath, conversation_id AS conversationId, task_id AS taskId, created_at AS createdAt, updated_at AS updatedAt FROM ideas ORDER BY updated_at DESC`).all().map((row) => this.idea(row as Row))
  }

  create(fields: IdeaFields): Idea {
    const now = this.now()
    const id = randomUUID()
    this.db.prepare('INSERT INTO ideas (id, title, notes, status, tags, project_path, conversation_id, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
      .run(id, fields.title, fields.notes, fields.status, JSON.stringify(fields.tags), fields.projectPath, now, now)
    const idea = this.get(id)
    this.changed(idea)
    return idea
  }

  update(id: string, fields: Partial<IdeaFields> & { conversationId?: string | null; taskId?: string | null }): Idea {
    const current = this.get(id)
    const next: Idea = {
      ...current,
      ...fields,
      tags: fields.tags ?? current.tags,
      projectPath: fields.projectPath === undefined ? current.projectPath : fields.projectPath,
      conversationId: fields.conversationId === undefined ? current.conversationId : fields.conversationId,
      taskId: fields.taskId === undefined ? current.taskId : fields.taskId,
      updatedAt: this.now()
    }
    this.db.prepare('UPDATE ideas SET title = ?, notes = ?, status = ?, tags = ?, project_path = ?, conversation_id = ?, task_id = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.notes, next.status, JSON.stringify(next.tags), next.projectPath, next.conversationId, next.taskId, next.updatedAt, id)
    const idea = this.get(id)
    this.changed(idea)
    return idea
  }

  remove(id: string): void {
    this.get(id)
    this.db.prepare('DELETE FROM ideas WHERE id = ?').run(id)
    this.changed(null)
  }

  private get(id: string): Idea {
    const row = this.db.prepare(`SELECT id, title, notes, status, tags, project_path AS projectPath, conversation_id AS conversationId, task_id AS taskId, created_at AS createdAt, updated_at AS updatedAt FROM ideas WHERE id = ?`).get(id)
    if (!row) throw new Rejection('idea-not-found')
    return this.idea(row as Row)
  }

  private idea(row: Row): Idea {
    return Idea.parse({
      ...row,
      tags: JSON.parse(row.tags)
    })
  }
}
