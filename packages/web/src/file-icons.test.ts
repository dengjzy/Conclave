import { describe, expect, it } from 'vitest'
import materialIcons from 'material-icon-theme/dist/material-icons.json'
import { fileIconId, fileIconUrl } from './file-icons'

describe('file icons', () => {
  it.each([
    ['main.py', 'python'], ['main.go', 'go'], ['Main.java', 'java'], ['app.dart', 'dart'],
    ['module.rs', 'rust'], ['view.vue', 'vue'], ['view.tsx', 'react_ts'], ['page.html', 'html'],
    ['image.png', 'image'], ['archive.zip', 'zip'], ['settings.yaml', 'yaml'], ['notes.md', 'markdown'],
    ['Dockerfile', 'docker'], ['.gitignore', 'git'], ['package.json', 'nodejs'], ['README.md', 'readme'],
    ['pom.xml', 'maven'], ['go.mod', 'go-mod'], ['tsconfig.json', 'tsconfig'],
    ['lib.d.ts', 'typescript-def'], ['component.test.ts', 'test-ts']
  ])('recognizes %s by its complete name or extension', (name, icon) => {
    expect(fileIconId(`/project/${name}`)).toBe(icon)
    expect(fileIconId(`C:\\project\\${name.toUpperCase()}`)).toBe(icon)
  })

  it('uses the containing folder for scoped names and theme variants for light and dark', () => {
    expect(fileIconId('/project/src/bashly-strings.yaml', { dark: true })).toBe('bashly-strings')
    expect(fileIconId('/project/src/bashly-strings.yaml', { dark: false })).toBe('bashly-strings_light')
    expect(fileIconId('/project/next.config.js', { dark: true })).toBe('next')
    expect(fileIconId('/project/next.config.js', { dark: false })).toBe('next_light')
  })

  it('distinguishes known, open and root folders and falls back for unknown names', () => {
    expect(fileIconId('/project/src', { directory: true })).toBe('folder-src')
    expect(fileIconId('/project/src', { directory: true, expanded: true })).toBe('folder-src-open')
    expect(fileIconId('/project/unusual', { directory: true })).toBe('folder')
    expect(fileIconId('/project/unusual', { directory: true, root: true })).toBe('folder-root')
    expect(fileIconId('/project/unusual', { directory: true, root: true, expanded: true })).toBe('folder-root-open')
    expect(fileIconId('/project/unknown.zzzz')).toBe('file')
    expect(fileIconId('/project/no-extension')).toBe('file')
  })

  it('bundles a local SVG for every upstream definition, with no broken or remote icons', () => {
    for (const [id, definition] of Object.entries(materialIcons.iconDefinitions)) {
      const filename = definition.iconPath.split('/').at(-1)
      const url = fileIconUrl(id)
      expect(url, id).toContain(`/${filename}`)
      expect(url, id).not.toMatch(/^https?:/)
    }
    expect(fileIconUrl('missing-icon')).toBe(fileIconUrl('file'))
  })
})
