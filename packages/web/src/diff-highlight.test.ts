import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DiffCode } from './components/DiffCode'
import { highlightDiff } from './diff-highlight'
import { diffRows } from './unified-diff'

describe('diff syntax highlighting', () => {
  it.each([
    ['app.ts', 'const count: number = 42'],
    ['APP.TS', 'const count: number = 42'],
    ['view.tsx', 'const node = <div title="hello">World</div>'],
    ['app.py', 'def greet(): return "hello"'],
    ['main.go', 'package main'],
    ['main.rs', 'let count = 42;'],
    ['main.dart', 'void main() { print("hello"); }'],
    ['Dockerfile', 'FROM node:22'],
    ['config.json', '{"count":42}'],
    ['app.vue', '<template><div title="hello">World</div></template>']
  ])('loads the existing grammar for %s without changing the diff text', async (path, code) => {
    const patch = `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${code}`
    const rows = diffRows(patch)
    const highlighted = await highlightDiff(rows, path)
    expect(highlighted.slice(0, 3)).toEqual(rows.slice(0, 3))
    expect(highlighted[3]?.tokens?.some((token) => token.className)).toBe(true)
    expect(highlighted[3]?.tokens?.map((token) => token.text).join('')).toBe(rows[3]?.text)
    expect(highlighted[3]?.tokens?.[0]).toEqual({ text: '+' })
  })

  it('keeps multiline tokens within their own side and hunk', async () => {
    const rows = diffRows('@@ -1,2 +1,2 @@\n-/* removed comment\n-continued */\n+const value = 42\n+const text = "hello"\n@@ -10 +10 @@\n-/* not closed\n+return "done"')
    const highlighted = await highlightDiff(rows, 'app.ts')
    expect(highlighted[1]?.tokens).toContainEqual({ text: '/* removed comment', className: 'hljs-comment' })
    expect(highlighted[2]?.tokens).toContainEqual({ text: 'continued */', className: 'hljs-comment' })
    expect(highlighted[3]?.tokens).toContainEqual({ text: 'const', className: 'hljs-keyword' })
    expect(highlighted[4]?.tokens).toContainEqual({ text: '"hello"', className: 'hljs-string' })
    expect(highlighted[7]?.tokens).toContainEqual({ text: 'return', className: 'hljs-keyword' })
    expect(highlighted.map((row) => ({ ...row, tokens: undefined }))).toEqual(rows.map((row) => ({ ...row, tokens: undefined })))
  })

  it.each(['+const count = 42', '--- app.ts\n+++ app.ts\n@@\n-const count = 1\n+const count = 42'])('highlights tool fragments without inventing line numbers', async (patch) => {
    const rows = diffRows(patch)
    const highlighted = await highlightDiff(rows, 'app.ts')
    const added = highlighted.find((row) => row.kind === 'diff-add')
    expect(added?.tokens).toContainEqual({ text: 'const', className: 'hljs-keyword' })
    expect(added?.tokens?.map((token) => token.text).join('')).toBe('+const count = 42')
    expect(added).toMatchObject({ hunk: null, oldLine: null, newLine: null })
  })

  it('preserves comment anchors and blank context rows and escapes code as text', async () => {
    const rows = diffRows('@@ -1,2 +1,2 @@\n\n-const html = "old"\n+const html = "<script>alert(1)</script>"')
    const highlighted = await highlightDiff(rows, 'app.ts')
    const blank = highlighted[1]
    const added = highlighted[3]
    if (!blank || !added) throw new Error('Missing highlighted rows')
    expect(renderToStaticMarkup(createElement(DiffCode, { row: blank }))).toBe(' ')
    const html = renderToStaticMarkup(createElement(DiffCode, { row: added }))
    expect(html).toContain('hljs-string')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('leaves unknown languages and oversized patches as plain text', async () => {
    for (const [path, patch] of [
      ['data.unknown', '@@ -0,0 +1 @@\n+const value = 42'],
      ['min.js', `@@ -0,0 +1 @@\n+${'x'.repeat(17 * 1024)}`],
      ['large.js', `@@ -0,0 +1,30000 @@\n${'+const value = 42\n'.repeat(30000)}`]
    ] as const) {
      const rows = diffRows(patch)
      expect(await highlightDiff(rows, path)).toBe(rows)
    }
  })
})
