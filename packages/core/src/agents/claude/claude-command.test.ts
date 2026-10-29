import { describe, expect, it } from 'vitest'
import { claudeEditDenials, claudeReadRules } from './claude-command'

describe('Claude permission rules', () => {
  it('lets Claude read exactly those files, and nothing about the folder', () => {
    expect(claudeReadRules(['/home/me/.conclave/attachments/a.png', '/home/me/odd,name/b.png', 'relative.png'])).toEqual([
      'Read(//home/me/.conclave/attachments/a.png)'
    ])
  })

  it('denies edits under each folder, leaving out what a comma would garble', () => {
    expect(claudeEditDenials(['/work/web app', '/work/a,b', 'relative'])).toEqual(['Edit(//work/web app/**)'])
  })

  it('writes a Windows path the way Claude matches it, so a fence there is not dropped', () => {
    expect(claudeEditDenials(['C:\\Users\\me\\.conclave\\worktrees\\t1\\web', 'D:/work/'])).toEqual([
      'Edit(//c/Users/me/.conclave/worktrees/t1/web/**)',
      'Edit(//d/work/**)'
    ])
    expect(claudeReadRules(['C:\\Users\\me\\a.png', '\\\\server\\share\\b.png'])).toEqual(['Read(//c/Users/me/a.png)'])
  })
})
