import { z } from 'zod'

export const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024

export const ResolvedFile = z.object({
  path: z.string(),
  root: z.string().nullable(),
  relative: z.string().nullable(),
  kind: z.enum(['file', 'directory'])
})
export type ResolvedFile = z.infer<typeof ResolvedFile>

export const FileRead = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string(), mtimeMs: z.number().optional() }),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['not-found', 'is-directory', 'binary', 'too-large', 'unreadable']) })
])
export type FileRead = z.infer<typeof FileRead>

export const MAX_DIRECTORY_ENTRIES = 5000

// `kind` is what a link points at; `other` is a broken link, a socket or the like.
export const DirectoryEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'directory', 'other']),
  symlink: z.boolean()
})
export type DirectoryEntry = z.infer<typeof DirectoryEntry>

export const DirectoryListing = z.object({ entries: z.array(DirectoryEntry), truncated: z.boolean() })
export type DirectoryListing = z.infer<typeof DirectoryListing>

// A conflict means the file changed on disk since the editor read it; `mtimeMs` is null when it is gone.
export const FileWrite = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), mtimeMs: z.number() }),
  z.object({ kind: z.literal('conflict'), mtimeMs: z.number().nullable() })
])
export type FileWrite = z.infer<typeof FileWrite>
