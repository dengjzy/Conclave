import { getLocale } from './i18n'
import { useEffect, useMemo, useState } from 'react'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { diffRows, type DiffRow } from './unified-diff'

export type DiffToken = { text: string; className?: string }
export type HighlightedDiffRow = DiffRow & { tokens?: DiffToken[] }

// Reuse the reply's token classes and the editor's language registry; grammars load on demand.
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'hljs-keyword' },
  { tag: [tags.string, tags.regexp], class: 'hljs-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'hljs-number' },
  { tag: tags.comment, class: 'hljs-comment' },
  { tag: [tags.function(tags.variableName), tags.heading], class: 'hljs-title' },
  { tag: [tags.typeName, tags.className], class: 'hljs-type' },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], class: 'hljs-variable' }
])

export async function highlightDiff(rows: readonly DiffRow[], path: string): Promise<readonly HighlightedDiffRow[]> {
  // Minified files and very large patches stay readable without blocking on their grammar.
  if (rows.reduce((size, row) => size + row.text.length + 1, 0) > 256 * 1024 || rows.some((row) => row.text.length > 16 * 1024)) return rows
  const name = path.split(/[\\/]/).at(-1) ?? path
  const description = LanguageDescription.matchFilename(languages, name) ?? LanguageDescription.matchFilename(languages, name.toLowerCase())
  if (!description) return rows
  const support = await description.load()
  const result: HighlightedDiffRow[] = rows.map((row) => ({ ...row }))
  const hunks = new Map<number, HighlightedDiffRow[]>()
  let fragment = -1
  for (const row of result) {
    // Tool edits also carry fragments with no line counts; their numbers must stay unknown.
    if (row.hunk === null) {
      if (row.kind === 'diff-hunk' || row.text.startsWith('diff ')) { fragment--; continue }
      if (row.kind !== 'diff-add' && row.kind !== 'diff-del' && !row.text.startsWith(' ')) continue
    }
    const key = row.hunk ?? fragment
    const hunk = hunks.get(key) ?? []
    hunk.push(row)
    hunks.set(key, hunk)
  }
  for (const hunk of hunks.values()) {
    // Parse the old and new sides separately, so an added comment cannot colour removed code.
    for (const side of ['oldLine', 'newLine'] as const) {
      const sideRows = hunk.filter((row) => row.hunk === null ? row.kind !== (side === 'oldLine' ? 'diff-add' : 'diff-del') : row[side] !== null)
      if (sideRows.length === 0) continue
      const code = sideRows.map((row) => row.text.slice(1)).join('\n')
      const ranges: { from: number; to: number; className: string }[] = []
      highlightTree(support.language.parser.parse(code), highlighter, (from, to, className) => ranges.push({ from, to, className }))
      let offset = 0
      let rangeIndex = 0
      for (const row of sideRows) {
        const text = row.text.slice(1)
        const end = offset + text.length
        const tokens: DiffToken[] = [{ text: row.text.slice(0, 1) }]
        let cursor = offset
        while (true) {
          const range = ranges[rangeIndex]
          if (!range || range.to > offset) break
          rangeIndex++
        }
        for (let at = rangeIndex; at < ranges.length; at++) {
          const range = ranges[at]
          if (!range || range.from >= end) break
          const from = Math.max(offset, range.from)
          const to = Math.min(end, range.to)
          if (from > cursor) tokens.push({ text: code.slice(cursor, from) })
          if (to > from) tokens.push({ text: code.slice(from, to), className: range.className })
          cursor = to
        }
        if (cursor < end) tokens.push({ text: code.slice(cursor, end) })
        row.tokens = tokens
        offset = end + 1
      }
    }
  }
  return result
}

export function useDiffHighlight(patch: string, path: string): readonly HighlightedDiffRow[] {
  const rows = useMemo(() => diffRows(patch), [patch, getLocale()])
  const [highlighted, setHighlighted] = useState<{ rows: readonly HighlightedDiffRow[]; source: readonly DiffRow[]; path: string } | null>(null)
  useEffect(() => {
    let current = true
    void highlightDiff(rows, path).then((highlighted) => {
      if (current) setHighlighted({ rows: highlighted, source: rows, path })
    }).catch(() => {})
    return () => { current = false }
  }, [rows, path])
  return highlighted?.source === rows && highlighted.path === path ? highlighted.rows : rows
}
