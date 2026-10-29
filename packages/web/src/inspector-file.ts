// Where a turn's edit of a file shows in a chat: its fold (null when the turn is not folded) and path.
export type ChatEdit = { conversationId: string; fold: string | null; path: string }

export type InspectorFile = {
  kind: 'task' | 'conversation'
  id: string
  project: string
  file: string
  revision: number
  // Opened from a turn's changes: the way back to that edit once git no longer has the file changed.
  edit: ChatEdit | null
}

type ProjectFolder = { project: string; folder: string }

// Renderer paths belong to core's platform, which may differ from the desktop's.
function normalized(path: string): string {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(path)
  const forward = windows ? path.replaceAll('\\', '/') : path
  const prefix = /^[a-z]:\//i.exec(forward)?.[0] ?? (forward.startsWith('//') ? '//' : '/')
  const parts: string[] = []
  for (const part of forward.slice(prefix.length).split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return prefix + parts.join('/')
}

function absoluteFile(path: string, cwd: string): string {
  const absolute = /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)
  return normalized(absolute ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`)
}

function within(file: string, folder: string): boolean {
  const windows = /^[a-z]:\/|^\/\//i.test(file)
  const compare = (value: string) => windows ? value.toLowerCase() : value
  return compare(file).startsWith(`${compare(normalized(folder).replace(/\/$/, ''))}/`)
}

// Whether a file an agent named lies in one of the chat's project folders, where git can show its
// changes; a file elsewhere (a plan under ~/.claude, say) has none to show.
export function insideProjects(path: string, cwd: string, folders: readonly string[]): boolean {
  const file = absoluteFile(path, cwd)
  return folders.some((folder) => within(file, folder))
}

export function locateInspectorFile(path: string, cwd: string, projects: readonly ProjectFolder[]): { project: string; file: string } | null {
  const file = absoluteFile(path, cwd)
  const matching = projects.filter(({ folder }) => within(file, folder))
    .sort((a, b) => normalized(b.folder).length - normalized(a.folder).length)
  // Core can still find files outside a selected subfolder but inside its git repository.
  const project = matching[0] ?? projects[0]
  return project ? { project: project.project, file } : null
}
