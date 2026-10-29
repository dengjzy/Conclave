import { t } from './i18n'
// How a line of a diff reads, for its colour, told by its text alone.
export function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  if (line.startsWith('@@')) return 'diff-hunk'
  return /^(diff |index |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line) ? 'diff-meta' : 'diff-context'
}

// A line of a unified diff, numbered where it sits in a hunk. hunk is null outside one (the file
// header), and for a line in one that says no code (`\ No newline at end of file`).
export type DiffRow = {
  text: string
  kind: string
  hunk: number | null
  oldLine: number | null
  newLine: number | null
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// Inside a hunk a line is told by its first character alone, by the counts its header gives:
// a removed `-- comment` reads `--- comment`, which outside one would be a file header.
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let hunk = -1
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0
  for (const text of patch.split('\n')) {
    const header = HUNK.exec(text)
    if (header) {
      hunk++
      oldLine = Number(header[1])
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLine = Number(header[3])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      rows.push({ text, kind: 'diff-hunk', hunk: null, oldLine: null, newLine: null })
      continue
    }
    const inHunk = oldLeft > 0 || newLeft > 0
    if (inHunk && text.startsWith('+') && newLeft > 0) {
      rows.push({ text, kind: 'diff-add', hunk, oldLine: null, newLine })
      newLine++
      newLeft--
    } else if (inHunk && text.startsWith('-') && oldLeft > 0) {
      rows.push({ text, kind: 'diff-del', hunk, oldLine, newLine: null })
      oldLine++
      oldLeft--
    } else if (inHunk && (text.startsWith(' ') || text === '') && oldLeft > 0 && newLeft > 0) {
      rows.push({ text, kind: 'diff-context', hunk, oldLine, newLine })
      oldLine++
      newLine++
      oldLeft--
      newLeft--
    } else {
      rows.push({ text, kind: text.startsWith('\\') ? 'diff-meta' : lineClass(text), hunk: null, oldLine: null, newLine: null })
    }
  }
  return rows
}

// What a row is known by in a comment's anchor: its side and number, and its text, so a diff
// that has moved on marks nothing rather than the wrong line. null for a row with no code.
export function diffRowId(row: DiffRow): string | null {
  if (row.hunk === null) return null
  return row.newLine === null ? `o${row.oldLine}:${row.text}` : `n${row.newLine}:${row.text}`
}

const MAX_QUOTED_LINES = 40

function span(lines: readonly number[]): string {
  const first = lines[0]
  const last = lines[lines.length - 1]
  return first === last ? `${first}` : `${first}-${last}`
}

// The passage a comment on these rows quotes: where they are, then the code as the diff has it,
// marks and all, which still finds the place once the numbers have moved.
export function diffQuoteText(path: string, rows: readonly DiffRow[]): string {
  const kept = rows.flatMap((row) => (row.newLine === null ? [] : [row.newLine]))
  const removed = rows.flatMap((row) => (row.oldLine === null ? [] : [row.oldLine]))
  const location = kept.length > 0 ? `${path}:${span(kept)}` : t('unifiedDiff.lineBeforeDeletion', { path: path, value2: span(removed) })
  const code = rows.slice(0, MAX_QUOTED_LINES).map((row) => row.text)
  const more = rows.length > MAX_QUOTED_LINES ? [t('unifiedDiff.linesTotal', { value1: rows.length })] : []
  return [location, ...code, ...more].join('\n')
}
