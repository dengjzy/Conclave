// A file change as the chat's unified-diff body, made from what an agent says it replaced: no line
// numbers or context, only the lines that went and came.
export const diffLines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

export function editPatch(before: string, after: string): string {
  return ['@@', ...diffLines(before).map((line) => `-${line}`), ...diffLines(after).map((line) => `+${line}`)].join('\n')
}

// A file written whole: every line added.
export function addedPatch(content: string): string {
  return diffLines(content).map((line) => `+${line}`).join('\n')
}
