import { describe, expect, it } from 'vitest'
import { diffQuoteText, diffRowId, diffRows } from './unified-diff'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,4 @@ function run() {',
  '   const a = 1',
  '-  const limit = 30',
  '--- a removed comment',
  '+  const limit = 40',
  '+  run(limit)',
  '   return a',
  '@@ -40 +40 @@',
  '-old end',
  '\\ No newline at end of file',
  '+new end',
  ''
].join('\n')

describe('diffRows', () => {
  const rows = diffRows(PATCH)
  const numbered = rows.map((row) => [row.kind, row.hunk, row.oldLine, row.newLine])

  it('numbers each line of a hunk on the side it is on, and leaves the header unnumbered', () => {
    expect(numbered.slice(0, 11)).toEqual([
      ['diff-meta', null, null, null],
      ['diff-meta', null, null, null],
      ['diff-meta', null, null, null],
      ['diff-meta', null, null, null],
      ['diff-hunk', null, null, null],
      ['diff-context', 0, 10, 10],
      ['diff-del', 0, 11, null],
      ['diff-del', 0, 12, null],
      ['diff-add', 0, null, 11],
      ['diff-add', 0, null, 12],
      ['diff-context', 0, 13, 13]
    ])
  })

  it('reads a one-line hunk header, and skips the no-newline note', () => {
    expect(numbered.slice(11)).toEqual([
      ['diff-hunk', null, null, null],
      ['diff-del', 1, 40, null],
      ['diff-meta', null, null, null],
      ['diff-add', 1, null, 40],
      ['diff-context', null, null, null]
    ])
  })

  it('numbers a new file git diff --no-index shows', () => {
    const rows = diffRows('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+one\n+two\n')
    expect(rows.filter((row) => row.hunk !== null).map((row) => row.newLine)).toEqual([1, 2])
  })

  it('knows a row by its side, number and text, and a header row not at all', () => {
    expect(rows.map(diffRowId).slice(4, 8)).toEqual([null, 'n10:   const a = 1', 'o11:-  const limit = 30', 'o12:--- a removed comment'])
  })
})

describe('diffQuoteText', () => {
  const rows = diffRows(PATCH)

  it('opens with the file and line, then the code with its marks', () => {
    expect(diffQuoteText('src/a.ts', rows.slice(8, 9))).toBe('src/a.ts:11\n+  const limit = 40')
  })

  it('spans the new lines of a range, with removed lines kept in it', () => {
    expect(diffQuoteText('src/a.ts', rows.slice(5, 11))).toBe([
      'src/a.ts:10-13',
      '   const a = 1',
      '-  const limit = 30',
      '--- a removed comment',
      '+  const limit = 40',
      '+  run(limit)',
      '   return a'
    ].join('\n'))
  })

  it('gives the old lines of a range that only removes', () => {
    expect(diffQuoteText('src/a.ts', rows.slice(6, 8))).toBe('src/a.ts（删除前第 11-12 行）\n-  const limit = 30\n--- a removed comment')
  })

  it('cuts a long range short, saying how long it was', () => {
    const long = diffRows(`@@ -0,0 +1,50 @@\n${Array.from({ length: 50 }, (_, at) => `+line ${at + 1}`).join('\n')}`).filter((row) => row.hunk !== null)
    const lines = diffQuoteText('x', long).split('\n')
    expect(lines[0]).toBe('x:1-50')
    expect(lines).toHaveLength(42)
    expect(lines.at(-2)).toBe('+line 40')
    expect(lines.at(-1)).toBe('…（共 50 行）')
  })
})
