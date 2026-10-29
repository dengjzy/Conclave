// The message that starts an agent on a handoff: Conclave's instruction to read the handoff file, then
// what the user added for the new agent. Clients show the user's part alone, and core keeps only
// that as said, so Conclave's wording stays out of the chat, its title and its search.
const PREFIX = '请先阅读 Conclave 移交文件 '
const SUFFIX = '，结合当前项目目录现状继续协助用户。'

export function handoffMessage(handoffPath: string, note = ''): string {
  const added = note.trim()
  return `${PREFIX}${handoffPath}${SUFFIX}${added ? `\n\n${added}` : ''}`
}

// null for any other message, including one that only mentions the handoff file.
export function parseHandoffMessage(text: string): { path: string; note: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) return null
  const end = trimmed.indexOf(SUFFIX, PREFIX.length)
  if (end < 0) return null
  const handoffPath = trimmed.slice(PREFIX.length, end)
  if (!handoffPath || /\s/.test(handoffPath)) return null
  return { path: handoffPath, note: trimmed.slice(end + SUFFIX.length).trim() }
}
