import { Prec, type EditorState, type TransactionSpec } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'

const UNORDERED_CHECKBOX = /^(\s*)([-*+]\s+\[[ xX]\])(\s+)(.*)$/
const UNORDERED_BULLET = /^(\s*)([-*+])(\s+)(.*)$/
const ORDERED = /^(\s*)(\d+)([.)])(\s+)(.*)$/
const CHINESE_ORDERED = /^(\s*)(\d+)([、）])(\s*)(.*)$/
const EMPTY_LIST_ITEM = /^\s*(\d+[.)、）]|[-*+]\s+\[[ xX]\]|[-*+])\s*$/

export type ParsedListItem = {
  kind: 'checkbox' | 'bullet' | 'ordered'
  indent: string
  marker: string
  nextMarker: string
  body: string
  empty: boolean
  number?: number
  delim?: string
  space?: string
}

type ViewLike = {
  composing?: boolean
  state: EditorState
  dispatch: (spec: TransactionSpec) => void
}

// Parses a line into list item metadata; returns null when the line is not a list item.
export function parseListItem(lineText: string): ParsedListItem | null {
  const checkbox = lineText.match(UNORDERED_CHECKBOX)
  if (checkbox) {
    const [, indent = '', mark = '', space = '', body = ''] = checkbox
    const marker = indent + mark + space
    const nextMarker = indent + '- [ ] '
    return { kind: 'checkbox', indent, marker, nextMarker, body, empty: body.trim() === '' }
  }
  const bullet = lineText.match(UNORDERED_BULLET)
  if (bullet) {
    const [, indent = '', mark = '', space = '', body = ''] = bullet
    const marker = indent + mark + space
    const nextMarker = marker
    return { kind: 'bullet', indent, marker, nextMarker, body, empty: body.trim() === '' }
  }
  const ordered = lineText.match(ORDERED)
  if (ordered) {
    const [, indent = '', rawNum = '', delim = '', space = '', body = ''] = ordered
    const num = parseInt(rawNum, 10)
    const marker = indent + rawNum + delim + space
    const nextMarker = indent + (num + 1) + delim + space
    return { kind: 'ordered', indent, marker, nextMarker, body, empty: body.trim() === '', number: num, delim, space }
  }
  const chinese = lineText.match(CHINESE_ORDERED)
  if (chinese) {
    const [, indent = '', rawNum = '', delim = '', space = '', body = ''] = chinese
    const num = parseInt(rawNum, 10)
    const marker = indent + rawNum + delim + space
    const nextMarker = indent + (num + 1) + delim + space
    return { kind: 'ordered', indent, marker, nextMarker, body, empty: body.trim() === '', number: num, delim, space }
  }
  return null
}

// Finds consecutive ordered list items following the given line that should increment or decrement.
function collectRenumberChanges(
  doc: EditorState['doc'],
  startLineNumber: number,
  indent: string,
  delim: string,
  startingExpectedNumber: number,
  delta: 1 | -1
): { from: number; to: number; insert: string }[] {
  const changes: { from: number; to: number; insert: string }[] = []
  let expectedNumber = startingExpectedNumber

  for (let lineNo = startLineNumber; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo)
    const parsed = parseListItem(line.text)
    if (!parsed || parsed.kind !== 'ordered') break
    if (parsed.indent !== indent || parsed.delim !== delim) break
    if (parsed.number !== expectedNumber) break

    const newNumber = parsed.number + delta
    if (newNumber <= 0) break
    const newMarker = parsed.indent + newNumber + parsed.delim + (parsed.space ?? '')
    changes.push({
      from: line.from,
      to: line.from + parsed.marker.length,
      insert: newMarker
    })
    expectedNumber++
  }

  return changes
}

// Inserts an incremented list marker on newline, or exits the list when the current item is empty.
export function continueList(view: ViewLike): boolean {
  if (view.composing || view.state.readOnly) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const line = view.state.doc.lineAt(sel.head)
  const parsed = parseListItem(line.text)
  if (!parsed) return false
  if (parsed.empty) {
    const renumberChanges = parsed.kind === 'ordered' && parsed.number !== undefined && parsed.delim !== undefined
      ? collectRenumberChanges(view.state.doc, line.number + 1, parsed.indent, parsed.delim, parsed.number + 1, -1)
      : []
    view.dispatch({
      changes: [
        { from: line.from, to: line.to, insert: parsed.indent },
        ...renumberChanges
      ],
      selection: { anchor: line.from + parsed.indent.length },
      userEvent: 'delete'
    })
    return true
  }
  if (sel.head < line.from + parsed.marker.length) return false
  const insert = '\n' + parsed.nextMarker
  const renumberChanges = parsed.kind === 'ordered' && parsed.number !== undefined && parsed.delim !== undefined
    ? collectRenumberChanges(view.state.doc, line.number + 1, parsed.indent, parsed.delim, parsed.number + 1, 1)
    : []
  view.dispatch({
    changes: [
      { from: sel.head, to: sel.head, insert },
      ...renumberChanges
    ],
    selection: { anchor: sel.head + insert.length },
    userEvent: 'input'
  })
  return true
}

// Clears the entire list marker in one keystroke when backspace is pressed on an empty item.
export function deleteListMarker(view: ViewLike): boolean {
  if (view.composing || view.state.readOnly) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const line = view.state.doc.lineAt(sel.head)
  const parsed = parseListItem(line.text)
  if (!parsed || !parsed.empty || sel.head !== line.to) return false
  const renumberChanges = parsed.kind === 'ordered' && parsed.number !== undefined && parsed.delim !== undefined
    ? collectRenumberChanges(view.state.doc, line.number + 1, parsed.indent, parsed.delim, parsed.number + 1, -1)
    : []
  view.dispatch({
    changes: [
      { from: line.from, to: line.to, insert: parsed.indent },
      ...renumberChanges
    ],
    selection: { anchor: line.from + parsed.indent.length },
    userEvent: 'delete'
  })
  return true
}

// Trims trailing empty list markers so unsent item templates do not reach the agent.
export function stripTrailingEmptyListItem(text: string): string {
  const lines = text.split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (last !== undefined && EMPTY_LIST_ITEM.test(last)) {
      lines.pop()
    } else {
      break
    }
  }
  return lines.join('\n').trimEnd()
}

export const chatListKeymap = Prec.highest(keymap.of([
  { key: 'Shift-Enter', run: (view: EditorView) => continueList(view) },
  { key: 'Enter', run: (view: EditorView) => continueList(view) },
  { key: 'Backspace', run: (view: EditorView) => deleteListMarker(view) }
]))
