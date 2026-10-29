import { t } from './i18n'
import type { DirectoryEntry } from '@conclave/protocol'

export type Listing = { entries: DirectoryEntry[]; truncated: boolean } | 'error'
// A folder row stands for a chain when compacted: `path` its first folder, which opens and closes it,
// and `folder` its last, whose entries show beneath it.
export type Row = { path: string; name: string; kind: DirectoryEntry['kind']; depth: number; root: string; folder?: string; detail?: string }

// Deep enough for any package path; a link that leads back into itself stops here.
const MAX_CHAIN = 16

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

// The folders a folder runs on into while each holds one folder and nothing else, as far as their
// listings are known: java, com, chowbus, menu read as one row, java/com/chowbus/menu.
function chainOf(folder: string, listings: Readonly<Record<string, Listing>>): string[] {
  const chain = [folder]
  while (chain.length < MAX_CHAIN) {
    const listing = listings[chain.at(-1) ?? folder]
    const only = listing && listing !== 'error' && !listing.truncated && listing.entries.length === 1 ? listing.entries[0] : undefined
    if (only?.kind !== 'directory') break
    chain.push(only.path)
  }
  return chain
}

// The rows the tree shows, and the folders whose listings it needs: each open one, and the rest of
// an open chain, so the chain can be found.
export function treeRows(roots: readonly string[], expanded: readonly string[], listings: Readonly<Record<string, Listing>>): { rows: Row[]; needed: string[] } {
  const rows: Row[] = []
  const needed: string[] = []
  const walk = (folder: string, root: string, depth: number) => {
    const listing = listings[folder]
    if (!listing || listing === 'error') return
    for (const entry of listing.entries) {
      if (entry.kind !== 'directory') {
        rows.push({ path: entry.path, name: entry.name, kind: entry.kind, depth, root })
        continue
      }
      const chain = chainOf(entry.path, listings)
      const last = chain.at(-1) ?? entry.path
      rows.push({ path: entry.path, name: [entry.name, ...chain.slice(1).map(baseName)].join('/'), kind: entry.kind, depth, root, folder: last })
      if (expanded.includes(entry.path)) {
        needed.push(...chain)
        walk(last, root, depth + 1)
      }
    }
    if (listing.truncated) rows.push({ path: `${folder}\0more`, name: t('fileTreeRows.onlyTheFirstEntriesAreShown'), kind: 'other', depth, root })
  }
  for (const root of roots) {
    rows.push({ path: root, name: baseName(root), kind: 'directory', depth: 0, root, folder: root })
    if (expanded.includes(root)) {
      needed.push(root)
      walk(root, root, 1)
    }
  }
  return { rows, needed }
}
