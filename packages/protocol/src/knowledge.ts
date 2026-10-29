import { z } from 'zod'

export const KnowledgeBaseKind = z.enum(['markdown', 'obsidian'])
export type KnowledgeBaseKind = z.infer<typeof KnowledgeBaseKind>

// The user's local notes, handed to every agent from its next start: their own folder, never a
// project of the conversation. write: whether agents may change it where their stage may edit.
export const KnowledgeBase = z.object({ path: z.string().min(1), write: z.boolean(), kind: KnowledgeBaseKind.optional() })
export type KnowledgeBase = z.infer<typeof KnowledgeBase>

// Missing on saved settings and clients from before Markdown folders were supported.
export function knowledgeBaseKind(base: KnowledgeBase): KnowledgeBaseKind {
  return base.kind ?? 'obsidian'
}

// Folders inside a vault that Claude Code and Cursor load as skills when given the vault, at a
// cost in tokens on every start.
export const AGENT_SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const

// A vault Obsidian's own registry lists; open: the one it has open now.
export const KnowledgeVault = z.object({ path: z.string(), name: z.string(), open: z.boolean(), skillDirs: z.array(z.string()) })
export type KnowledgeVault = z.infer<typeof KnowledgeVault>

// What a folder the user picked holds: vault when Obsidian has opened it (an .obsidian folder).
export const KnowledgeFolder = z.object({ vault: z.boolean(), skillDirs: z.array(z.string()) })
export type KnowledgeFolder = z.infer<typeof KnowledgeFolder>
