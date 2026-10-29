import { describe, expect, it } from 'vitest'
import type { DirectoryEntry } from '@conclave/protocol'
import { treeRows, type Listing } from './file-tree-rows'

const dir = (path: string): DirectoryEntry => ({ name: path.split('/').at(-1) ?? path, path, kind: 'directory', symlink: false })
const file = (path: string): DirectoryEntry => ({ ...dir(path), kind: 'file' })
const listing = (...entries: DirectoryEntry[]): Listing => ({ entries, truncated: false })

const root = '/p'
const listings: Record<string, Listing> = {
  '/p': listing(dir('/p/src')),
  '/p/src': listing(dir('/p/src/main'), dir('/p/src/test')),
  '/p/src/main': listing(dir('/p/src/main/java'), dir('/p/src/main/resources')),
  '/p/src/main/java': listing(dir('/p/src/main/java/com')),
  '/p/src/main/java/com': listing(dir('/p/src/main/java/com/chowbus')),
  '/p/src/main/java/com/chowbus': listing(dir('/p/src/main/java/com/chowbus/menu')),
  '/p/src/main/java/com/chowbus/menu': listing(dir('/p/src/main/java/com/chowbus/menu/ai'), file('/p/src/main/java/com/chowbus/menu/App.java'))
}
const names = (rows: ReturnType<typeof treeRows>['rows']) => rows.map((row) => `${'  '.repeat(row.depth)}${row.name}`)

describe('file tree rows', () => {
  it('reads a folder holding one folder and nothing else as one row with it, as far as listings go', () => {
    const { rows, needed } = treeRows([root], [root, '/p/src', '/p/src/main', '/p/src/main/java'], listings)
    expect(names(rows)).toEqual(['p', '  src', '    main', '      java/com/chowbus/menu', '        ai', '        App.java', '      resources', '    test'])
    // The row opens and closes by its first folder and acts as its last.
    expect(rows[3]).toMatchObject({ path: '/p/src/main/java', folder: '/p/src/main/java/com/chowbus/menu' })
    expect(needed).toEqual([root, '/p/src', '/p/src/main', '/p/src/main/java', '/p/src/main/java/com', '/p/src/main/java/com/chowbus', '/p/src/main/java/com/chowbus/menu'])
  })

  it('keeps a project root apart, and a chain short of what is not yet listed', () => {
    const partial = Object.fromEntries(Object.entries(listings).filter(([path]) => path !== '/p/src/main/java/com/chowbus'))
    const { rows, needed } = treeRows([root], [root, '/p/src', '/p/src/main', '/p/src/main/java'], partial)
    expect(names(rows).slice(0, 4)).toEqual(['p', '  src', '    main', '      java/com/chowbus'])
    // What it still needs to find the rest.
    expect(needed).toContain('/p/src/main/java/com/chowbus')
  })

  it('stops a chain at a folder that also holds a file, an error or a cut-off list', () => {
    const alone = (entries: Listing) => treeRows([root], [root], { '/p': listing(dir('/p/a')), '/p/a': entries }).rows.map((row) => row.name)
    expect(alone(listing(dir('/p/a/b'), file('/p/a/x')))).toEqual(['p', 'a'])
    expect(alone('error')).toEqual(['p', 'a'])
    expect(alone({ entries: [dir('/p/a/b')], truncated: true })).toEqual(['p', 'a'])
    expect(alone(listing(dir('/p/a/b')))).toEqual(['p', 'a/b'])
  })

  it('stops a folder that leads back into itself', () => {
    const loop: Record<string, Listing> = { '/p': listing(dir('/p/a')) }
    let path = '/p/a'
    for (let i = 0; i < 40; i++) { loop[path] = listing(dir(`${path}/a`)); path = `${path}/a` }
    const [, row] = treeRows([root], [root], loop).rows
    expect(row?.name.split('/')).toHaveLength(16)
  })
})
