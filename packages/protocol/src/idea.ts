import { z } from 'zod'

// A thought, before it has a project, an agent or a definition of done. A todo is the same record
// with status 'todo': the user's own list, not a run.
export const IDEA_STATUSES = ['idea', 'todo', 'doing', 'done', 'archived'] as const
export const IdeaStatus = z.enum(IDEA_STATUSES)
export type IdeaStatus = z.infer<typeof IdeaStatus>

export const IdeaTitle = z.string().trim().min(1).max(200)
export const IdeaNotes = z.string().max(20_000)

export const Idea = z.object({
  id: z.string(),
  title: IdeaTitle,
  notes: IdeaNotes,
  status: IdeaStatus,
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  // Where an agent should work when this becomes a conversation or a task.
  projectPath: z.string().nullable(),
  conversationId: z.string().nullable(),
  taskId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Idea = z.infer<typeof Idea>

export const IdeaFields = z.object({
  title: IdeaTitle,
  notes: IdeaNotes.default(''),
  status: IdeaStatus.default('idea'),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  projectPath: z.string().trim().min(1).max(2000).nullable().default(null)
})
export type IdeaFields = z.infer<typeof IdeaFields>
