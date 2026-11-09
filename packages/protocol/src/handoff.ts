// The message that starts an agent on a handoff: Conclave's instruction to read the handoff file, then
// what the user added for the new agent. Clients show the user's part alone, and core keeps only
// that as said, so Conclave's wording stays out of the chat, its title and its search.
const PREFIX = '请先阅读 Conclave 移交文件 '
const SUFFIX = '，结合当前项目目录现状继续协助用户。'
// A fork that this agent cannot take over natively reads a record of its own earlier work instead.
// Same file, different framing: nothing was handed to anyone, so the agent must not distrust the
// notes as another agent's.
const FORK_PREFIX = '请先阅读 Conclave 分叉记录 '
const FORK_SUFFIX = '，这是同一个 Agent 在同一目录里新开的会话，按这份记录接着做，不要重做已经完成的部分。'

function seed(prefix: string, path: string, suffix: string, note = ''): string {
  const added = note.trim()
  return `${prefix}${path}${suffix}${added ? `\n\n${added}` : ''}`
}

function parseSeed(text: string, prefix: string, suffix: string): { path: string; note: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(prefix)) return null
  const end = trimmed.indexOf(suffix, prefix.length)
  if (end < 0) return null
  const path = trimmed.slice(prefix.length, end)
  if (!path || /\s/.test(path)) return null
  return { path, note: trimmed.slice(end + suffix.length).trim() }
}

export function handoffMessage(handoffPath: string, note = ''): string {
  return seed(PREFIX, handoffPath, SUFFIX, note)
}

// null for any other message, including one that only mentions the handoff file.
export function parseHandoffMessage(text: string): { path: string; note: string } | null {
  return parseSeed(text, PREFIX, SUFFIX)
}

export function forkMessage(forkPath: string): string {
  return seed(FORK_PREFIX, forkPath, FORK_SUFFIX)
}

// null for a handoff's message and for anything else the user wrote.
export function parseForkMessage(text: string): { path: string } | null {
  const parsed = parseSeed(text, FORK_PREFIX, FORK_SUFFIX)
  return parsed && { path: parsed.path }
}
