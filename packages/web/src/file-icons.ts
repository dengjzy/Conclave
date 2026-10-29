import type { Manifest } from 'material-icon-theme'
import materialIcons from 'material-icon-theme/dist/material-icons.json'

const theme: Manifest = materialIcons
// Keep the SVGs as local assets, rather than embedding the whole collection in JavaScript.
const assets: Record<string, string> = Object.fromEntries(Object.entries(import.meta.glob<string>(
  '../../../node_modules/material-icon-theme/icons/*.svg',
  { eager: true, query: '?url&no-inline', import: 'default' }
)).map(([path, url]) => [path.split('/').at(-1) ?? '', url]))

type Associations = 'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded' | 'rootFolderNames' | 'rootFolderNamesExpanded'
type IconOptions = { directory?: boolean; expanded?: boolean; root?: boolean; dark?: boolean }

export function fileIconId(path: string, { directory = false, expanded = false, root = false, dark = false }: IconOptions = {}): string {
  const parts = path.toLowerCase().split(/[\\/]/).filter(Boolean)
  const name = parts.at(-1) ?? ''
  const parent = parts.at(-2)
  const light = dark ? undefined : theme.light
  const association = (kind: Associations, key: string) => light?.[kind]?.[key] ?? theme[kind]?.[key]
  const named = (kind: Associations) => (parent ? association(kind, `${parent}/${name}`) : undefined) ?? association(kind, name)

  if (directory) {
    if (root) return (expanded ? association('rootFolderNamesExpanded', name) : undefined)
      ?? association('rootFolderNames', name)
      ?? (expanded ? light?.rootFolderExpanded ?? theme.rootFolderExpanded : undefined)
      ?? light?.rootFolder ?? theme.rootFolder ?? 'folder-root'
    return (expanded ? named('folderNamesExpanded') : undefined) ?? named('folderNames')
      ?? (expanded ? light?.folderExpanded ?? theme.folderExpanded : undefined)
      ?? light?.folder ?? theme.folder ?? 'folder'
  }

  const exact = named('fileNames')
  if (exact) return exact
  const suffixes = name.split('.').slice(1).map((_, index, parts) => parts.slice(index).join('.'))
  // Parent-specific matches precede every plain extension; compound extensions precede short ones.
  if (parent) for (const suffix of suffixes) {
    const icon = association('fileExtensions', `${parent}/${suffix}`)
    if (icon) return icon
  }
  for (const suffix of suffixes) {
    const icon = association('fileExtensions', suffix)
    if (icon) return icon
  }
  return light?.file ?? theme.file ?? 'file'
}

export function fileIconUrl(id: string): string | undefined {
  const filename = theme.iconDefinitions?.[id]?.iconPath.split('/').at(-1)
  return (filename ? assets[filename] : undefined) ?? assets['file.svg']
}
