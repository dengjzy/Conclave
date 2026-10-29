import path from 'node:path'

// The first of these paths that lies in one of a task's reference projects, which the agent may
// only read: an edit there is refused before anyone is asked.
export function referencePathIn(references: readonly string[], paths: readonly string[]): string | null {
  return paths.find((file) => references.some((dir) => {
    const relative = path.relative(dir, path.resolve(dir, file))
    return !relative.startsWith('..') && !path.isAbsolute(relative)
  })) ?? null
}
