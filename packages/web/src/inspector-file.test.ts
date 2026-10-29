import { describe, expect, it } from 'vitest'
import { insideProjects, locateInspectorFile } from './inspector-file'

describe('inspector file location', () => {
  const projects = [{ project: '/repo/api', folder: '/wt/api' }, { project: '/repo/api-web', folder: '/wt/api-web' }]

  it('distinguishes identical filenames across projects and uses worktrees rather than source repos', () => {
    expect(locateInspectorFile('/wt/api-web/src/app.ts', '/wt/api', projects)).toEqual({ project: '/repo/api-web', file: '/wt/api-web/src/app.ts' })
    expect(locateInspectorFile('/wt/api/src/app.ts', '/wt/api', projects)).toEqual({ project: '/repo/api', file: '/wt/api/src/app.ts' })
  })

  it('resolves relative paths from the agent working directory, including additional projects', () => {
    expect(locateInspectorFile('./src/../app.ts', '/wt/api', projects)).toEqual({ project: '/repo/api', file: '/wt/api/app.ts' })
    expect(locateInspectorFile('../api-web/app.ts', '/wt/api', projects)).toEqual({ project: '/repo/api-web', file: '/wt/api-web/app.ts' })
    expect(locateInspectorFile('app.ts', '/', [{ project: '/', folder: '/' }])).toEqual({ project: '/', file: '/app.ts' })
  })

  it('uses directory boundaries and the most specific project folder', () => {
    const folders = [{ project: '/wt', folder: '/wt' }, { project: '/wt/api', folder: '/wt/api' }]
    expect(locateInspectorFile('/wt/api/a.ts', '/wt', folders)?.project).toBe('/wt/api')
    expect(locateInspectorFile('/wt/api-web/a.ts', '/wt', folders)?.project).toBe('/wt')
  })

  it('lets core validate files outside the picked subfolder and returns nothing without projects', () => {
    expect(locateInspectorFile('/repo/shared/a.ts', '/repo/web', [{ project: '/repo/web', folder: '/repo/web' }])).toEqual({ project: '/repo/web', file: '/repo/shared/a.ts' })
    expect(locateInspectorFile('/repo/a.ts', '/repo', [])).toBeNull()
  })

  it('handles Windows drive and UNC paths independently of the desktop platform', () => {
    const folders = [{ project: 'C:\\repo', folder: 'C:\\wt\\app' }, { project: 'D:\\repo', folder: 'D:/wt/app' }]
    expect(locateInspectorFile('src\\a.ts', 'C:\\wt\\app', folders)).toEqual({ project: 'C:\\repo', file: 'C:/wt/app/src/a.ts' })
    expect(locateInspectorFile('d:\\wt\\APP\\a.ts', 'C:\\wt\\app', folders)).toEqual({ project: 'D:\\repo', file: 'd:/wt/APP/a.ts' })
    expect(locateInspectorFile('a.ts', '\\\\server\\share\\repo', [{ project: 'share', folder: '\\\\server\\share\\repo' }])).toEqual({ project: 'share', file: '//server/share/repo/a.ts' })
  })

  it('tells files in the project folders from ones elsewhere', () => {
    const folders = ['/wt/api', '/wt/web']
    expect(insideProjects('src/app.ts', '/wt/api', folders)).toBe(true)
    expect(insideProjects('../web/app.ts', '/wt/api', folders)).toBe(true)
    expect(insideProjects('/wt/api-web/app.ts', '/wt/api', folders)).toBe(false)
    expect(insideProjects('/Users/me/.claude/plans/plan.md', '/wt/api', folders)).toBe(false)
    expect(insideProjects('C:\\Repo\\API\\a.ts', 'C:\\Repo\\API', ['c:\\repo\\api'])).toBe(true)
    expect(insideProjects('a.ts', '/wt/api', [])).toBe(false)
  })
})
